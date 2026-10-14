import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NotFoundError,
  UserError,
  openStore,
  parseVerdict,
  type OpenStoreOptions,
  type Frontier,
  type Store,
} from "./store.ts";

const SCRIPT = join(import.meta.dir, "orch.ts");

const directories: string[] = [];

const handles: Store[] = [];

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "orch-test-"));
  directories.push(directory);

  return directory;
}

function useStore(
  directory: string,
  options?: OpenStoreOptions
): Store {
  const store = openStore(directory, options);
  handles.push(store);

  return store;
}

async function initializedStore(): Promise<{
  readonly directory: string;
  readonly store: Store;
}> {
  const directory = await makeDirectory();
  const store = useStore(directory);
  await store.init();

  return { directory, store };
}

function git({
  args,
  repo,
}: {
  args: readonly string[];
  repo: string;
}): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args]);

  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`
    );
  }

  return result.stdout.toString().trim();
}

async function makeGitStack(directory: string): Promise<{
  readonly repo: string;
  readonly mergedSha: string;
  readonly closedSha: string;
  readonly openSha: string;
}> {
  const repo = join(directory, "repo");
  await mkdir(repo);
  git({ repo, args: ["init", "--initial-branch=main"] });
  git({ repo, args: ["config", "user.name", "Orch Test"] });
  git({ repo, args: ["config", "user.email", "orch@example.com"] });
  await writeFile(join(repo, "main.txt"), "main\n");
  git({ repo, args: ["add", "."] });
  git({ repo, args: ["commit", "-m", "main"] });

  const branches = ["stack/merged", "stack/closed", "stack/open"];

  for (const [index, branch] of branches.entries()) {
    git({ repo, args: ["checkout", "-b", branch] });
    await writeFile(join(repo, `stack-${index}.txt`), `${branch}\n`);
    git({ repo, args: ["add", "."] });
    git({ repo, args: ["commit", "-m", branch] });
  }

  return {
    repo,
    mergedSha: git({ repo, args: ["rev-parse", "stack/merged"] }),
    closedSha: git({ repo, args: ["rev-parse", "stack/closed"] }),
    openSha: git({ repo, args: ["rev-parse", "stack/open"] }),
  };
}

const execFileSync = childProcess.execFileSync;

function releasedStack() {
  return {
    trunk: "main",
    currentBranch: "stack/open",
    branches: [
      { name: "stack/merged", isCurrent: false, isMerged: true, isQueued: false, needsRebase: false,
        pr: { number: 10, state: "MERGED" } },
      { name: "stack/closed", isCurrent: false, isMerged: false, isQueued: false, needsRebase: false,
        pr: { number: 13, state: "OPEN" } },
      { name: "stack/open", isCurrent: true, isMerged: false, isQueued: true, needsRebase: true,
        pr: { number: 11, state: "QUEUED" } },
    ],
  };
}

async function withFakeGh<T>({
  directory,
  operation,
  output,
  fail,
  gitOutput,
  pullRequest = (number: number) => ({
    number,
    headRefName: ({ 10: "stack/merged", 13: "stack/closed", 11: "stack/open" })[number],
    state: ({ 10: "MERGED", 13: "CLOSED", 11: "OPEN" })[number],
  }),
}: {
  directory: string;
  operation: (calls: readonly string[]) => Promise<T>;
  output: string;
  pullRequest?: (number: number) => unknown;
  fail?: "view" | "pr" | "git";
  gitOutput?: string;
}): Promise<T> {
  const calls: string[] = [];

  const launch = spyOn(childProcess, "execFileSync").mockImplementation(new Proxy(execFileSync, {
    apply(_target, _receiver, [command, args = [], options]: Parameters<typeof execFileSync>) {
      calls.push(`${command} ${args.join(" ")}`);

      if (
        (fail === "git" && command === "git") ||
        (fail === "view" && command === "gh" && args[0] === "stack") ||
        (fail === "pr" && command === "gh" && args[0] === "pr")
      ) throw Object.assign(new Error("simulated launch failure or timeout"), { code: "ETIMEDOUT" });

      if (command === "git") {
        expect(args.slice(0, 3)).toEqual(["rev-parse", "--verify", "--end-of-options"]);
        expect(options).toMatchObject({ cwd: join(directory, "repo"), timeout: 10_000, shell: false });

        return gitOutput ?? execFileSync(command, args, options);
      }

      if (command !== "gh") throw new Error(`unexpected executable: ${command}`);
      expect(options).toMatchObject({
        cwd: join(directory, "repo"), timeout: 30_000, windowsHide: true, shell: false,
        maxBuffer: 4 * 1024 * 1024,
      });

      if (JSON.stringify(args) === JSON.stringify(["stack", "view", "--json"])) return output;

      if (args[0] === "pr" && args[1] === "view") {
        expect(args).toEqual(["pr", "view", args[2], "--json", "number,headRefName,state"]);

        return JSON.stringify(pullRequest(Number(args[2])));
      }

      throw new Error(`unexpected gh arguments: ${JSON.stringify(args)}`);
    },
  }));

  try {
    return await operation(calls);
  } finally {
    launch.mockRestore();
  }
}

function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env
): RunResult {
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], { env });

  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

afterEach(async () => {
  for (const store of handles.splice(0).reverse()) {
    await store.close();
  }

  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Store", () => {
  it("initializes an idempotent plain-file store and releases its lock", async () => {
    const directory = await makeDirectory();
    const store = useStore(directory);

    expect(await store.init()).toEqual({ store: directory });
    const firstUnits = await readFile(join(directory, "units.tsv"), "utf8");

    const firstLedger = await readFile(
      join(directory, "ledger.tsv"),
      "utf8"
    );

    expect(await store.init()).toEqual({ store: directory });
    expect(await readFile(join(directory, "units.tsv"), "utf8")).toBe(
      firstUnits
    );
    expect(await readFile(join(directory, "ledger.tsv"), "utf8")).toBe(
      firstLedger
    );
    expect((await readdir(directory)).sort()).toEqual([
      ".orch.lock",
      "frontier.json",
      "gates.md",
      "inbox",
      "ledger.tsv",
      "preferences.md",
      "units.tsv",
    ]);

    await store.close();
    expect(await readdir(directory)).not.toContain(".orch.lock");
  });

  it("composes unit add, set, get, list, and counts", async () => {
    const { store } = await initializedStore();

    expect(
      await store.units.add({
        id: "u1",
        track: "build",
        brief: "briefs/u1.md",
      })
    ).toMatchObject({ id: "u1", state: "pending" });
    expect(
      await store.units.add({ id: "=SUM(A1)", track: "+build" })
    ).toMatchObject({ id: "'=SUM(A1)", track: "'+build" });

    const updated = await store.units.set({
      id: "u1",
      state: "done",
      branch: "poteto/u1",
      pr: 184530,
      sha: "abc123",
    });

    expect(updated).toEqual({
      id: "u1",
      track: "build",
      state: "done",
      branch: "poteto/u1",
      pr: "184530",
      sha: "abc123",
      brief: "briefs/u1.md",
    });
    expect(await store.units.get("u1")).toEqual(updated);
    expect(
      await store.units.list({ state: "done", track: "build" })
    ).toEqual([updated]);
    expect(await store.units.counts()).toEqual({ done: 1, pending: 1 });
    await expect(
      store.units.add({ id: "u1", track: "build" })
    ).rejects.toThrow("unit u1 already exists");
    await expect(
      store.units.set({ id: "missing", state: "done" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("records, replaces, checks, and summarizes typed ledger verdicts", async () => {
    const { store } = await initializedStore();

    try {
      await store.ledger.check({ pr: 184530, sha: "abc123" });
      throw new Error("expected ledger check to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError);

      if (error instanceof NotFoundError) {
        expect(error.output).toEqual({
          compact: "NOT-VERIFIED",
          json: {
            pr: "184530",
            sha: "abc123",
            verdict: "NOT-VERIFIED",
          },
        });
      }
    }

    expect(() => parseVerdict("looks-good")).toThrow("verdict must be");

    const recorded = await store.ledger.record({
      pr: 184530,
      sha: "abc123",
      verdict: "unit-test-verified",
      evidence: "reports/verify.md",
      verifier: "sol",
    });

    expect(await store.ledger.check({ pr: 184530, sha: "abc123" })).toEqual(
      recorded
    );
    expect(await store.ledger.summary()).toEqual({
      "unit-test-verified": 1,
    });

    await store.ledger.record({
      pr: 184530,
      sha: "abc123",
      verdict: "live-ui-verified",
      evidence: "reports/live.md",
    });
    expect(await store.ledger.summary()).toEqual({
      "live-ui-verified": 1,
    });
  });

  it("pushes, peeks, and atomically drains inbox pointers", async () => {
    const { directory, store } = await initializedStore();

    const first = await store.inbox.push({
      agent: "worker-1",
      unit: "u1",
      status: "done",
      report: "reports/u1.md",
    });

    expect(first.pointer).toMatchObject({ unit: "u1", status: "done" });
    expect(first.filename).toEndWith(".tsv");
    await store.inbox.push({
      agent: "worker-2",
      unit: "u2",
      status: "failed",
    });

    expect(await store.inbox.count()).toBe(2);
    expect(await store.inbox.peek()).toHaveLength(2);
    expect(await store.inbox.count()).toBe(2);
    expect(await store.inbox.drain()).toHaveLength(2);
    expect(await store.inbox.count()).toBe(0);
    expect(await readdir(join(directory, "inbox"))).toEqual([]);
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith(".inbox-drain-")
      )
    ).toEqual([]);
  });

  it("replaces a stale lock whose holder pid is dead", async () => {
    const { directory } = await initializedStore();
    const exited = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
    await exited.exited;
    await writeFile(join(directory, ".orch.lock"), `${exited.pid}\n`);

    const stale: string[] = [];

    const recovered = useStore(directory, {
      onStaleLock: (holder) => stale.push(holder),
    });

    expect(
      await recovered.units.add({ id: "u1", track: "build" })
    ).toMatchObject({ id: "u1" });
    expect(stale).toEqual([String(exited.pid)]);
    await recovered.close();
    expect(await readdir(directory)).not.toContain(".orch.lock");
  });

  it("blocks a writer and steals the pid lock only with force", async () => {
    const { directory, store } = await initializedStore();
    await store.close();
    await writeFile(join(directory, ".orch.lock"), `${process.pid}\n`);

    const blocked = useStore(directory);
    await expect(
      blocked.units.add({ id: "u1", track: "build" })
    ).rejects.toThrow(`store lock held by pid ${process.pid}`);

    const stolen: string[] = [];

    const forced = useStore(directory, {
      force: true,
      onLockStolen: (holder) => stolen.push(holder),
    });

    expect(
      await forced.units.add({ id: "u1", track: "build" })
    ).toMatchObject({ id: "u1" });
    expect(stolen).toEqual([String(process.pid)]);
    await forced.close();
    expect(await readdir(directory)).not.toContain(".orch.lock");
  });

  it("parks gates, stores standing orders, and renders status", async () => {
    const { directory, store } = await initializedStore();
    await store.units.add({ id: "u1", track: "build" });
    expect(
      await store.gates.park({
        id: "release",
        question: "Ship now?",
        options: "ship,wait",
        defaultAnswer: "wait",
      })
    ).toMatchObject({ kind: "open", id: "release" });
    expect(
      await store.standing.add({ line: "Never force push." })
    ).toEqual({ number: 1, line: "Never force push." });

    const first = await store.status.render();
    expect(first.changed).toBe("first render");
    expect(first.summary.openGateIds).toEqual(["release"]);
    expect(await readFile(join(directory, "status.md"), "utf8")).toContain(
      "| release | open | Ship now? |"
    );
    expect((await store.status.render()).changed).toBe("no derived changes");

    expect(
      await store.gates.resolve({ id: "release", answer: "ship" })
    ).toMatchObject({ kind: "resolved", answer: "ship" });
    expect((await store.status.render()).changed).toBe("open gates 1->0");
    expect(await store.gates.list()).toEqual([]);
    expect(await store.standing.show()).toEqual([
      { number: 1, line: "Never force push." },
    ]);
  });

  it("resolves released gh-stack JSON with authoritative lifecycle and a complete ordered pin", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);

    await withFakeGh({
      directory,
      output: JSON.stringify(releasedStack()),
      operation: async () => {
        expect(await store.frontier.set({ repo: stack.repo })).toEqual({
          generation: 1,
          prs: [
            {
              pr: 10,
              branches: "stack/merged",
              sha: stack.mergedSha,
              state: "MERGED",
            },
            {
              pr: 13,
              branches: "stack/closed",
              sha: stack.closedSha,
              state: "CLOSED",
            },
            {
              pr: 11,
              branches: "stack/open",
              sha: stack.openSha,
              state: "OPEN",
            },
          ],
          lowestUnmerged: 11,
        });
        expect(
          (
            await store.frontier.set({
              repo: stack.repo,
              prs: [10, 13, 11],
            })
          ).generation
        ).toBe(2);
        expect((await store.frontier.show()).generation).toBe(2);
        await expect(
          store.frontier.set({
            repo: stack.repo,
            prs: [10, 11, 12],
          })
        ).rejects.toThrow(
          "frontier pin mismatch: missing from gh-stack: 12; extra in gh-stack: 13"
        );
        await expect(
          store.frontier.set({
            repo: stack.repo,
            prs: [13, 10, 11],
          })
        ).rejects.toThrow(
          "frontier pin mismatch: order differs: expected 13,10,11; gh-stack 10,13,11"
        );
        await expect(
          store.frontier.set({
            repo: stack.repo,
            prs: [10, 10],
          })
        ).rejects.toThrow("--prs must not contain duplicates");
      },
    });
  });

  it("rejects malformed gh-stack JSON without changing the frontier", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);

    await withFakeGh({
      directory,
      output: "{not JSON",
      operation: async () => {
        await expect(
          store.frontier.set({ repo: stack.repo })
        ).rejects.toThrow(
          "gh stack view returned malformed JSON"
        );
        expect(await store.frontier.show()).toEqual({ generation: 0, prs: [], lowestUnmerged: null });
      },
    });
  });

  it.each([
    ["missing trunk", (value: ReturnType<typeof releasedStack>) => Object.assign(value, { trunk: null })],
    ["missing current branch", (value: ReturnType<typeof releasedStack>) => Object.assign(value, { currentBranch: "" })],
    ["unknown current branch", (value: ReturnType<typeof releasedStack>) => Object.assign(value, { currentBranch: "unknown" })],
    ["non-array branches", (value: ReturnType<typeof releasedStack>) => Object.assign(value, { branches: {} })],
    ["missing PR", (value: ReturnType<typeof releasedStack>) => Object.assign(value.branches[0], { pr: undefined })],
    ["invalid PR number", (value: ReturnType<typeof releasedStack>) => Object.assign(value.branches[0].pr, { number: 0 })],
    ["unsafe PR number", (value: ReturnType<typeof releasedStack>) => Object.assign(value.branches[0].pr, { number: Number.MAX_SAFE_INTEGER + 1 })],
    ["unknown display state", (value: ReturnType<typeof releasedStack>) => Object.assign(value.branches[0].pr, { state: "FUTURE" })],
    ["non-string display state", (value: ReturnType<typeof releasedStack>) => Object.assign(value.branches[0].pr, { state: ["OPEN"] })],
    ["non-boolean topology", (value: ReturnType<typeof releasedStack>) => Object.assign(value.branches[0], { needsRebase: "false" })],
    ["incorrect current flag", (value: ReturnType<typeof releasedStack>) => Object.assign(value.branches[0], { isCurrent: true })],
    ["duplicate branch", (value: ReturnType<typeof releasedStack>) => Object.assign(value.branches[1], { name: value.branches[0].name })],
    ["duplicate PR", (value: ReturnType<typeof releasedStack>) => Object.assign(value.branches[1].pr, { number: 10 })],
    ["trunk in branches", (value: ReturnType<typeof releasedStack>) => Object.assign(value.branches[0], { name: "main" })],
    ["option-shaped branch", (value: ReturnType<typeof releasedStack>) => Object.assign(value.branches[0], { name: "--help" })],
    ["invalid optional head", (value: ReturnType<typeof releasedStack>) => Object.assign(value.branches[0], { head: 12 })],
  ])("rejects %s before any frontier write or live PR read", async (_label, mutate) => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    const value = releasedStack();
    mutate(value);
    const before = await readFile(join(directory, "frontier.json"), "utf8");

    await withFakeGh({
      directory, output: JSON.stringify(value),
      operation: async (calls) => {
        await expect(store.frontier.set({ repo: stack.repo })).rejects.toBeInstanceOf(UserError);
        expect(calls).toEqual(["gh stack view --json"]);
        expect(await readFile(join(directory, "frontier.json"), "utf8")).toBe(before);
      },
    });
  });

  it.each([
    { number: 99, headRefName: "stack/merged", state: "MERGED" },
    { number: 10, headRefName: "other", state: "MERGED" },
    { number: 10, headRefName: "stack/merged", state: "QUEUED" },
    { number: 10, headRefName: "stack/merged", state: null },
  ])("rejects GitHub lifecycle or identity mismatch %j without partial persistence", async (live) => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);

    await withFakeGh({
      directory, output: JSON.stringify(releasedStack()), pullRequest: () => live,
      operation: async () => {
        await expect(store.frontier.set({ repo: stack.repo })).rejects.toThrow("invalid lifecycle or identity");
        expect(await store.frontier.show()).toEqual({ generation: 0, prs: [], lowestUnmerged: null });
      },
    });
  });

  it.each(["view", "pr", "git"] as const)("preserves the prior frontier after a %s command failure", async (fail) => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    let previous: Frontier;

    await withFakeGh({
      directory, output: JSON.stringify(releasedStack()),
      operation: async () => { previous = await store.frontier.set({ repo: stack.repo }); },
    });
    await withFakeGh({
      directory, output: JSON.stringify(releasedStack()), fail,
      operation: async () => {
        await expect(store.frontier.set({ repo: stack.repo })).rejects.toThrow("simulated launch failure or timeout");
        expect(await store.frontier.show()).toEqual(previous);
      },
    });
  });

  it("reacquires the complete stack and accepts omitted optional fields on each refresh", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    const value = releasedStack();
    value.currentBranch = "main";
    value.branches[2].isCurrent = false;

    await withFakeGh({
      directory, output: JSON.stringify(value),
      operation: async (calls) => {
        await store.frontier.set({ repo: stack.repo, prs: [10, 13, 11] });
        const first = [...calls];
        await store.frontier.set({ repo: stack.repo, prs: [10, 13, 11] });
        expect(calls).toEqual([...first, ...first]);
        expect(first.filter((command) => command.startsWith("gh pr view"))).toHaveLength(3);
        expect(first[0]).toBe("gh stack view --json");
      },
    });
  });

  it("accepts released optional wire fields but persists the local Git head", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    const value = releasedStack();
    Object.assign(value.branches[0], { head: "a".repeat(40), base: "b".repeat(40) });
    Object.assign(value.branches[0].pr, { url: "https://github.com/example/repo/pull/10" });

    await withFakeGh({
      directory, output: JSON.stringify(value),
      operation: async () => {
        const frontier = await store.frontier.set({ repo: stack.repo });
        expect(frontier.prs[0].sha).toBe(stack.mergedSha);
      },
    });
  });

  it("resolves local branch heads rather than same-named tags", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    execFileSync("git", ["tag", "stack/merged", stack.openSha], { cwd: stack.repo });

    await withFakeGh({
      directory, output: JSON.stringify(releasedStack()),
      operation: async () => {
        const frontier = await store.frontier.set({ repo: stack.repo });
        expect(frontier.prs[0].sha).toBe(stack.mergedSha);
      },
    });
  });

  it("does not persist partially acquired rows when a later PR identity fails", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);

    await withFakeGh({
      directory, output: JSON.stringify(releasedStack()),
      pullRequest: (number) => ({ number, headRefName: number === 10 ? "stack/merged" : "wrong", state: "MERGED" }),
      operation: async (calls) => {
        await expect(store.frontier.set({ repo: stack.repo })).rejects.toThrow("invalid lifecycle or identity");
        expect(calls.some((command) => command.startsWith("git rev-parse"))).toBe(true);
        expect(await store.frontier.show()).toEqual({ generation: 0, prs: [], lowestUnmerged: null });
      },
    });
  });

  it("rejects an invalid local SHA without substituting a remote wire head", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);

    await withFakeGh({
      directory, output: JSON.stringify(releasedStack()), gitOutput: "not-a-sha",
      operation: async () => {
        await expect(store.frontier.set({ repo: stack.repo })).rejects.toThrow("returned an invalid SHA");
        expect(await store.frontier.show()).toEqual({ generation: 0, prs: [], lowestUnmerged: null });
      },
    });
  });

  it("rejects malformed TSV, verdict, frontier, and inbox data", async () => {
    const { directory, store } = await initializedStore();

    await writeFile(join(directory, "units.tsv"), "wrong\n");
    await expect(store.units.list()).rejects.toThrow(
      "units.tsv has an invalid header"
    );
    await writeFile(
      join(directory, "units.tsv"),
      "id\ttrack\tstate\tbranch\tpr\tsha\tbrief\nshort\trow\n"
    );
    await expect(store.units.list()).rejects.toThrow(
      "units.tsv has a malformed row"
    );

    await writeFile(
      join(directory, "ledger.tsv"),
      "pr\tsha\tverdict\tevidence\tverifier\tts\n1\tsha\tinvalid\treport\tme\tnow\n"
    );
    await expect(store.ledger.summary()).rejects.toThrow(
      "ledger.tsv has invalid verdict invalid"
    );

    await writeFile(join(directory, "frontier.json"), '{"generation":"1"}\n');
    await expect(store.frontier.show()).rejects.toThrow(
      "frontier.json has an invalid shape"
    );

    await writeFile(join(directory, "inbox", "bad.tsv"), "too\tshort\n");
    await expect(store.inbox.peek()).rejects.toThrow(
      "inbox pointer bad.tsv is malformed"
    );
  });

  it("rejects operations after close", async () => {
    const { store } = await initializedStore();
    await store.close();
    await expect(store.units.list()).rejects.toThrow("store is closed");
    await expect(store.status.render()).rejects.toBeInstanceOf(UserError);
  });
});

describe("orch CLI", () => {
  it("prints commander help and rejects invalid parsing with exit 1", async () => {
    const help = runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Commands:");
    expect(help.stdout).toContain("unit");
    expect(help.stdout).toContain("ledger");

    const frontierHelp = runCli(["frontier", "set", "--help"]);
    expect(frontierHelp.code).toBe(0);
    expect(frontierHelp.stdout).toContain("--repo <dir>");
    expect(frontierHelp.stdout).toContain("--prs <n,...>");

    const directory = await makeDirectory();
    const invalid = runCli(["--store", directory, "unit", "add", "u1"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("required option '--track <track>'");
  });

  it("accepts ORCH_STORE and emits complete JSON", async () => {
    const directory = await makeDirectory();
    const env = { ...process.env, ORCH_STORE: directory };
    expect(runCli(["init"], env).code).toBe(0);

    const added = runCli(
      ["unit", "add", "u1", "--track", "build", "--json"],
      env
    );

    expect(added.code).toBe(0);
    expect(JSON.parse(added.stdout)).toEqual({
      id: "u1",
      track: "build",
      state: "pending",
      branch: "",
      pr: "",
      sha: "",
      brief: "",
    });
  });

  it("maps user and not-found outcomes to the preserved exit codes", async () => {
    const directory = await makeDirectory();
    expect(runCli(["--store", directory, "init"]).code).toBe(0);

    const missingRepo = runCli([
      "--store",
      directory,
      "frontier",
      "set",
    ]);

    expect(missingRepo.code).toBe(1);
    expect(missingRepo.stderr).toContain(
      "set --repo <dir> or ORCH_REPO"
    );

    const userError = runCli([
      "--store",
      directory,
      "unit",
      "add",
      "",
      "--track",
      "build",
    ]);

    expect(userError.code).toBe(1);
    expect(userError.stderr).toContain("unit id must not be empty");

    const missingUnit = runCli([
      "--store",
      directory,
      "unit",
      "get",
      "missing",
    ]);

    expect(missingUnit.code).toBe(2);
    expect(missingUnit.stderr).toContain("unit missing not found");

    const missingLedger = runCli([
      "--store",
      directory,
      "--json",
      "ledger",
      "check",
      "184530",
      "abc123",
    ]);

    expect(missingLedger.code).toBe(2);
    expect(JSON.parse(missingLedger.stdout)).toEqual({
      pr: "184530",
      sha: "abc123",
      verdict: "NOT-VERIFIED",
    });
    expect(missingLedger.stderr).toBe("");
  });
});
