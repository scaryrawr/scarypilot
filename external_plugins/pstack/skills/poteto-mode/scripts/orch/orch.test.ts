import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  NotFoundError,
  UserError,
  openStore,
  parseVerdict,
  type Forge,
  type OpenStoreOptions,
  type Store,
} from "./store.ts";

const SCRIPT = join(import.meta.dir, "orch.mjs");

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
  readonly draftSha: string;
}> {
  const repo = join(directory, "repo");
  await mkdir(repo);
  git({ repo, args: ["init", "--initial-branch=main"] });
  git({ repo, args: ["config", "user.name", "Orch Test"] });
  git({ repo, args: ["config", "user.email", "orch@example.com"] });
  await writeFile(join(repo, "main.txt"), "main\n");
  git({ repo, args: ["remote", "add", "origin", "https://github.com/example/project.git"] });
  git({ repo, args: ["add", "."] });
  git({ repo, args: ["commit", "-m", "main"] });

  const branches = [
    "stack/merged",
    "stack/closed",
    "stack/open",
    "stack/draft",
  ];

  for (const [index, branch] of branches.entries()) {
    git({ repo, args: ["checkout", "-b", branch] });
    await writeFile(join(repo, `stack-${index}.txt`), `${branch}\n`);
    git({ repo, args: ["add", "."] });
    git({ repo, args: ["commit", "-m", branch] });
  }

  git({ repo, args: ["checkout", "stack/open"] });

  return {
    repo,
    mergedSha: git({ repo, args: ["rev-parse", "stack/merged"] }),
    closedSha: git({ repo, args: ["rev-parse", "stack/closed"] }),
    openSha: git({ repo, args: ["rev-parse", "stack/open"] }),
    draftSha: git({ repo, args: ["rev-parse", "stack/draft"] }),
  };
}

type FixtureState = "open" | "draft" | "merged" | "closed";

const FORGE_FIXTURES: Readonly<
  Record<
    Forge,
    {
      readonly fields: string;
      readonly row: (pr: {
        number: number;
        state: FixtureState;
        head: string;
        base: string;
        repository?: string;
      }) => Record<string, unknown>;
    }
  >
> = {
  gh: {
    fields: "number,state,headRefName,baseRefName,headRepository",
    row: ({ number, state, head, base, repository = "example/project" }) => ({
      number,
      state: state === "draft" ? "OPEN" : state.toUpperCase(),
      headRefName: head,
      baseRefName: base,
      headRepository: { nameWithOwner: repository },
    }),
  },
};

function forgeRows(
  forge: Forge,
  prs: readonly {
    number: number;
    state: FixtureState;
    head: string;
    base: string;
    repository?: string;
  }[]
): string {
  return JSON.stringify(prs.map((pr) => FORGE_FIXTURES[forge].row(pr)));
}

async function withFakeForge<T>({
  directory,
  forge,
  operation,
  currentRows,
  childRows,
  sshConfig,
  queries = [],
  hostname = "github.com",
}: {
  directory: string;
  forge: Forge;
  operation: () => Promise<T>;
  currentRows?: string;
  childRows?: string;
  sshConfig?: string;
  queries?: readonly {
    repository: string;
    filter: "--head" | "--base";
    branch: string;
    rows: string;
  }[];
  hostname?: string;
}): Promise<T> {
  const bin = join(directory, "bin");
  const outputPath = join(directory, "forge-output.txt").replaceAll("\\", "/");
  await mkdir(bin, { recursive: true });
  await writeFile(
    outputPath,
    `${
      currentRows ??
      forgeRows(forge, [
        {
          number: 11,
          state: "open",
          head: "stack/open",
          base: "stack/closed",
        },
      ])
    }\n`
  );
  const { fields } = FORGE_FIXTURES[forge];

  const list = (filter: string, branch: string, repository = "example/project"): string =>
    `pr list ${filter} ${branch} --state all --limit 1000 --json ${fields} --repo ${hostname}/${repository}`;

  const fake = join(bin, forge);
  const ssh = join(bin, "ssh");
  const nativeSsh = Bun.which("ssh");

  if (sshConfig && !nativeSsh) throw new Error("SSH alias regression requires OpenSSH");
  await writeFile(ssh, sshConfig ? `#!/usr/bin/env bash
exec "${nativeSsh.replaceAll("\\", "/")}" -F "${sshConfig.replaceAll("\\", "/")}" "$@"
` : `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "-G -- git@github.com"|"-G -- git@github-work"|"-G -p 2222 -- git@github-work")
    printf 'host github-work\\nhostname github.com\\nuser git\\n'
    ;;
  *)
    printf 'unexpected ssh arguments: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`);
  await chmod(ssh, 0o755);
  await writeFile(
    fake,
    `#!/usr/bin/env bash
set -euo pipefail
if [ ! "." -ef "${realpathSync(join(directory, "repo")).replaceAll("\\", "/")}" ]; then
  printf '${forge} ran outside the fixture repo: %s\\n' "$(pwd -P)" >&2
  exit 2
fi
case "$*" in
  ${queries.map(query => `"${list(query.filter, query.branch, query.repository)}")
    printf '%s\\n' '${query.rows}'
    ;;`).join("\n  ")}
  "repo view --json url --jq .url")
    printf 'https://${hostname}/example/project\\n'
    ;;
  "repo view https://${hostname}/example/project.git --json url --jq .url")
    printf 'https://${hostname}/example/project\\n'
    ;;
  "repo view https://${hostname}/contributor/project.git --json url --jq .url")
    printf 'https://${hostname}/contributor/project\\n'
    ;;
  "${list("--head", "stack/open")}")
    cat "${outputPath}"
    ;;
  "${list("--head", "stack/closed")}")
    printf '%s\\n' '${forgeRows(forge, [{ number: 13, state: "closed", head: "stack/closed", base: "stack/merged" }])}'
    ;;
  "${list("--head", "stack/merged")}")
    printf '%s\\n' '${forgeRows(forge, [{ number: 10, state: "merged", head: "stack/merged", base: "main" }])}'
    ;;
  "${list("--base", "stack/open")}")
    printf '%s\\n' '${childRows ?? forgeRows(forge, [
      { number: 14, state: "draft", head: "stack/draft", base: "stack/open" },
      {
        number: 15,
        state: "closed",
        head: "stack/abandoned",
        base: "stack/open",
      },
    ])}'
    ;;
  "${list("--base", "stack/draft")}")
    printf '[]\\n'
    ;;
  pr\\ list\\ *\\ --repo\\ ${hostname}/contributor/project)
    printf '[]\\n'
    ;;
  *)
    printf 'unexpected ${forge} arguments: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`
  );
  await chmod(fake, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;

  try {
    const resolvedForge = Bun.which(forge, { PATH: process.env.PATH });

    if (!resolvedForge || realpathSync(resolvedForge) !== realpathSync(fake)) {
      throw new Error("Forge fixture must shadow the installed CLI before running tests");
    }

    return await operation();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
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
      verifier: "opus",
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
    const exited = Bun.spawn(["true"]);
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

  for (const forge of ["gh"] as const) {
    it(`resolves the ordered frontier from the ${forge} base chain and validates an optional pin`, async () => {
      const { directory, store } = await initializedStore();
      const stack = await makeGitStack(directory);
      const forgeParams = forge === "gh" ? {} : { forge };
      await withFakeForge({
        directory,
        forge,
        operation: async () => {
          expect(
            await store.frontier.set({ repo: stack.repo, ...forgeParams })
          ).toEqual({
            generation: 1,
            prs: [
              {
                pr: 10,
                branches: "stack/merged",
                sha: stack.mergedSha,
                state: "MERGED",
                repository: "github.com/example/project",
                headRepository: "github.com/example/project",
              },
              {
                pr: 13,
                branches: "stack/closed",
                sha: stack.closedSha,
                state: "CLOSED",
                repository: "github.com/example/project",
                headRepository: "github.com/example/project",
              },
              {
                pr: 11,
                branches: "stack/open",
                sha: stack.openSha,
                state: "OPEN",
                repository: "github.com/example/project",
                headRepository: "github.com/example/project",
              },
              {
                pr: 14,
                branches: "stack/draft",
                sha: stack.draftSha,
                state: "OPEN",
                repository: "github.com/example/project",
                headRepository: "github.com/example/project",
              },
            ],
            lowestUnmerged: 11,
          });
          expect(
            (
              await store.frontier.set({
                repo: stack.repo,
                ...forgeParams,
                prs: [10, 13, 11, 14],
              })
            ).generation
          ).toBe(2);
          expect((await store.frontier.show()).generation).toBe(2);
          await expect(
            store.frontier.set({
              repo: stack.repo,
              ...forgeParams,
              prs: [10, 11, 12],
            })
          ).rejects.toThrow(
            "frontier pin mismatch: missing from resolved chain: 12; extra in resolved chain: 13,14"
          );
          await expect(
            store.frontier.set({
              repo: stack.repo,
              ...forgeParams,
              prs: [13, 10, 11, 14],
            })
          ).rejects.toThrow(
            "frontier pin mismatch: order differs: expected 13,10,11,14; resolved 10,13,11,14"
          );
          await expect(
            store.frontier.set({
              repo: stack.repo,
              ...forgeParams,
              prs: [10, 10],
            })
          ).rejects.toThrow("frontier pin mismatch");
        },
      });
    });
    it(`rejects unparseable ${forge} output loudly`, async () => {
      const { directory, store } = await initializedStore();
      const stack = await makeGitStack(directory);
      await withFakeForge({
        directory,
        forge,
        currentRows: "this line is not forge output",
        operation: async () => {
          await expect(
            store.frontier.set({ repo: stack.repo, forge })
          ).rejects.toThrow(
            `${forge} pr list --head stack/open output is not valid JSON`
          );
        },
      });
    });
  }

  it("names the missing pull request when a chain branch has none", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);

    await withFakeForge({
      directory,
      forge: "gh",
      currentRows: "[]",
      operation: async () => {
        await expect(store.frontier.set({ repo: stack.repo })).rejects.toThrow(
          "branch stack/open has no pull request; open one with gh pr create"
        );
      },
    });

  });

  it("prefers the sole active PR over closed and merged branch history", async () => {
      const { directory, store } = await initializedStore();
      const stack = await makeGitStack(directory);
      await withFakeForge({
        directory,
        forge: "gh",
        currentRows: forgeRows("gh", [
          { number: 8, state: "closed", head: "stack/open", base: "main" },
          { number: 9, state: "merged", head: "stack/open", base: "main" },
          { number: 11, state: "open", head: "stack/open", base: "stack/closed" },
        ]),
        operation: async () => {
          const frontier = await store.frontier.set({ repo: stack.repo });
          expect(frontier.prs.map(row => row.pr)).toEqual([10, 13, 11, 14]);
          expect(frontier.lowestUnmerged).toBe(11);
        },
      });
    });

  it("rejects multiple active PRs rather than choosing one", async () => {
      const { directory, store } = await initializedStore();
      const stack = await makeGitStack(directory);
      await withFakeForge({
        directory,
        forge: "gh",
        currentRows: forgeRows("gh", [
          { number: 8, state: "closed", head: "stack/open", base: "main" },
          { number: 11, state: "open", head: "stack/open", base: "stack/closed" },
          { number: 12, state: "draft", head: "stack/open", base: "stack/closed" },
        ]),
        operation: async () => {
          await expect(store.frontier.set({ repo: stack.repo })).rejects.toThrow(
            "branch stack/open has multiple pull requests (#11, #12)"
          );
        },
      });
    });

  it("does not prefer a fork's active PR over the intended remote's closed history", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    await withFakeForge({
      directory,
      forge: "gh",
      currentRows: forgeRows("gh", [
        { number: 8, state: "closed", head: "stack/open", base: "stack/closed" },
        { number: 11, state: "open", head: "stack/open", base: "main", repository: "contributor/project" },
      ]),
      operation: async () => {
        const frontier = await store.frontier.set({ repo: stack.repo });
        expect(frontier.prs.map(row => row.pr)).toEqual([10, 13, 8, 14]);
        expect(frontier.prs[2]?.sha).toBe(stack.openSha);
        expect(frontier.prs[2]?.state).toBe("CLOSED");
        const bundledStore = join(directory, "bundled-store");
        expect(runCli(["--store", bundledStore, "--json", "init"]).code).toBe(0);
        const result = runCli(["--store", bundledStore, "--json", "frontier", "set", "--repo", stack.repo]);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(frontier);
      },
    });
  });

  it("ignores same-name fork candidates before checking active PR ambiguity", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    await withFakeForge({
      directory,
      forge: "gh",
      currentRows: forgeRows("gh", [
        { number: 11, state: "open", head: "stack/open", base: "stack/closed", repository: "Example/Project" },
        { number: 12, state: "open", head: "stack/open", base: "main", repository: "contributor/project" },
      ]),
      operation: async () => {
        const frontier = await store.frontier.set({ repo: stack.repo });
        expect(frontier.prs.map(row => row.pr)).toEqual([10, 13, 11, 14]);
      },
    });
  });

  it("uses the push remote without attaching an upstream namesake's child", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    git({ repo: stack.repo, args: ["remote", "add", "fork", "git@github.com:contributor/project.git"] });
    git({ repo: stack.repo, args: ["config", "branch.stack/open.remote", "origin"] });
    git({ repo: stack.repo, args: ["config", "branch.stack/open.pushRemote", "fork"] });
    await withFakeForge({
      directory,
      forge: "gh",
      currentRows: forgeRows("gh", [
        { number: 11, state: "open", head: "stack/open", base: "main", repository: "contributor/project" },
        { number: 12, state: "open", head: "stack/open", base: "main" },
      ]),
      operation: async () => {
        const frontier = await store.frontier.set({ repo: stack.repo });
        const bundledStore = join(directory, "bundled-store");
        expect(runCli(["--store", bundledStore, "--json", "init"]).code).toBe(0);
        const result = runCli(["--store", bundledStore, "--json", "frontier", "set", "--repo", stack.repo]);
        expect(result.code).toBe(0);
        const bundled = JSON.parse(result.stdout);
        const persisted = JSON.parse(await readFile(join(bundledStore, "frontier.json"), "utf8"));
        expect([
          frontier.prs.map(row => row.pr),
          (await store.frontier.show()).prs.map(row => row.pr),
          bundled.prs.map((row: { pr: number }) => row.pr),
          persisted.prs.map((row: { pr: number }) => row.pr),
        ]).toEqual([[11], [11], [11], [11]]);
      },
    });
  });

  it("ignores fork children before checking that the stack is linear", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    await withFakeForge({
      directory,
      forge: "gh",
      childRows: forgeRows("gh", [
        { number: 14, state: "open", head: "stack/draft", base: "stack/open" },
        { number: 15, state: "open", head: "stack/foreign", base: "stack/open", repository: "contributor/project" },
      ]),
      operation: async () => {
        const frontier = await store.frontier.set({ repo: stack.repo });
        expect(frontier.prs.map(row => row.pr)).toEqual([10, 13, 11, 14]);
      },
    });
  });

  for (const { current, childPr } of [
    { current: "stack/open", childPr: 14 },
    { current: "stack/draft", childPr: 14 },
    { current: "stack/open", childPr: 11 },
  ]) {
    it(`preserves pinned fork-to-fork dependencies from ${current} with child PR ${childPr}`, async () => {
      const { directory, store } = await initializedStore();
      const stack = await makeGitStack(directory);
      git({ repo: stack.repo, args: ["remote", "add", "fork", "git@github.com:contributor/project.git"] });

      for (const branch of ["stack/open", "stack/draft"]) {
        git({ repo: stack.repo, args: ["config", `branch.${branch}.pushRemote`, "fork"] });
      }

      git({ repo: stack.repo, args: ["checkout", current] });

      const parent = forgeRows("gh", [
        { number: 11, state: "open", head: "stack/open", base: "main", repository: "contributor/project" },
      ]);

      const child = forgeRows("gh", [
        { number: childPr, state: "open", head: "stack/draft", base: "stack/open", repository: "contributor/project" },
      ]);

      await withFakeForge({
        directory,
        forge: "gh",
        currentRows: parent,
        queries: [
          { repository: "contributor/project", filter: "--base", branch: "stack/open", rows: child },
          { repository: "example/project", filter: "--head", branch: "stack/draft", rows: "[]" },
          { repository: "contributor/project", filter: "--head", branch: "stack/draft", rows: child },
        ],
        operation: async () => {
          const frontier = await store.frontier.set({ repo: stack.repo, prs: [11, childPr] });
          expect(frontier.prs).toEqual([
            { pr: 11, branches: "stack/open", sha: stack.openSha, state: "OPEN", repository: "github.com/example/project", headRepository: "github.com/contributor/project" },
            { pr: childPr, branches: "stack/draft", sha: stack.draftSha, state: "OPEN", repository: "github.com/contributor/project", headRepository: "github.com/contributor/project" },
          ]);
          expect(await store.frontier.show()).toEqual(frontier);
          const bundledStore = join(directory, "bundled-store");
          expect(runCli(["--store", bundledStore, "--json", "init"]).code).toBe(0);
          const result = runCli(["--store", bundledStore, "--json", "frontier", "set", "--repo", stack.repo, "--prs", `11,${childPr}`]);
          expect(result.code).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual(frontier);
          expect(JSON.parse(await readFile(join(bundledStore, "frontier.json"), "utf8"))).toEqual(frontier);
          await expect(store.frontier.set({ repo: stack.repo, prs: [11, childPr, 11] })).rejects.toThrow("frontier pin mismatch");
          expect(await store.frontier.show()).toEqual(frontier);
          const badPin = runCli(["--store", bundledStore, "--json", "frontier", "set", "--repo", stack.repo, "--prs", `11,${childPr},11`]);
          expect(badPin.code).toBe(1);
          expect(badPin.stderr).toContain("frontier pin mismatch");
          expect(JSON.parse(await readFile(join(bundledStore, "frontier.json"), "utf8"))).toEqual(frontier);
        },
      });
    });
  }

  it("keeps the checkout's Enterprise host when the CLI default host differs", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    git({ repo: stack.repo, args: ["remote", "set-url", "origin", "https://ghe.example/example/project.git"] });
    const previousHost = process.env.GH_HOST;
    process.env.GH_HOST = "github.com";

    try {
      await withFakeForge({
        directory,
        forge: "gh",
        hostname: "ghe.example",
        operation: async () => {
          const frontier = await store.frontier.set({ repo: stack.repo });
          expect(frontier.prs.map(row => row.pr)).toEqual([10, 13, 11, 14]);

          for (const row of frontier.prs) {
            expect(row.repository).toBe("ghe.example/example/project");
            expect(row.headRepository).toBe("ghe.example/example/project");
          }

          expect(await store.frontier.show()).toEqual(frontier);
          const bundledStore = join(directory, "bundled-store");
          expect(runCli(["--store", bundledStore, "--json", "init"]).code).toBe(0);
          const result = runCli(["--store", bundledStore, "--json", "frontier", "set", "--repo", stack.repo]);
          expect(result.code).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual(frontier);
          expect(JSON.parse(await readFile(join(bundledStore, "frontier.json"), "utf8"))).toEqual(frontier);
        },
      });
    } finally {
      if (previousHost === undefined) delete process.env.GH_HOST;
      else process.env.GH_HOST = previousHost;
    }
  });

  it("reads legacy frontiers but rejects incomplete repository identities", async () => {
    const { directory, store } = await initializedStore();
    const row = { pr: 11, branches: "stack/open", sha: "abc123", state: "OPEN" };
    const legacy = { generation: 1, prs: [row], lowestUnmerged: 11 };
    const file = join(directory, "frontier.json");
    await writeFile(file, JSON.stringify(legacy));
    expect(await store.frontier.show()).toEqual(legacy);

    const hostless = {
      ...legacy,
      prs: [{ ...row, repository: "example/project", headRepository: "contributor/project" }],
    };

    await writeFile(file, JSON.stringify(hostless));
    expect(await store.frontier.show()).toEqual(hostless);

    for (const identity of [
      { repository: "example/project" },
      { repository: "example/project", headRepository: "invalid" },
    ]) {
      await writeFile(file, JSON.stringify({ ...legacy, prs: [{ ...row, ...identity }] }));
      await expect(store.frontier.show()).rejects.toThrow("invalid PR repository");
    }
  });

  for (const remoteUrl of [
    "git@github-work:example/project.git",
    "ssh://git@github-work:2222/example/project.git",
  ]) {
    it(`resolves an SSH host alias before querying the repository: ${remoteUrl}`, async () => {
      const { directory, store } = await initializedStore();
      const stack = await makeGitStack(directory);
      const sshConfig = join(directory, "ssh_config");
      await writeFile(sshConfig, "Host github-work\n  HostName github.com\n  User git\n");
      git({ repo: stack.repo, args: ["remote", "set-url", "--push", "origin", remoteUrl] });
      await withFakeForge({
        directory,
        forge: "gh",
        sshConfig,
        operation: async () => {
          const frontier = await store.frontier.set({ repo: stack.repo });
          expect(frontier.prs.map(row => row.pr)).toEqual([10, 13, 11, 14]);
          const bundledStore = join(directory, "bundled-store");
          expect(runCli(["--store", bundledStore, "--json", "init"]).code).toBe(0);
          const result = runCli(["--store", bundledStore, "--json", "frontier", "set", "--repo", stack.repo]);
          expect(result.code).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual(frontier);
        },
      });
    });
  }

  it("rejects PR rows whose head repository identity is unavailable", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    await withFakeForge({
      directory,
      forge: "gh",
      currentRows: JSON.stringify([{
        number: 11,
        state: "OPEN",
        headRefName: "stack/open",
        baseRefName: "main",
        headRepository: null,
      }]),
      operation: async () => {
        await expect(store.frontier.set({ repo: stack.repo })).rejects.toThrow("output has an invalid PR row");
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
    expect(frontierHelp.stdout).toContain("--forge <forge>");
    expect(frontierHelp.stdout).toContain("--prs <n,...>");

    const directory = await makeDirectory();
    const invalid = runCli(["--store", directory, "unit", "add", "u1"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("required option '--track <track>'");

    const badForge = runCli([
      "--store",
      directory,
      "frontier",
      "set",
      "--repo",
      directory,
      "--forge",
      "gt",
    ]);

    expect(badForge.code).toBe(1);
    expect(badForge.stderr).toContain("Allowed choices are gh");
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
