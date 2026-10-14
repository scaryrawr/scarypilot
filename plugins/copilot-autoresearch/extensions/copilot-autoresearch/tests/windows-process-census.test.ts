import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runShell, runShellStreaming, type ProcessControl, type SpawnOptions, type SpawnResult } from "../src/spawn.ts";
import { censusCommand, observeCommand, ownedCensus, type OwnedPids } from "./owned-process-census.ts";

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Owned-process census phase timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("owned Windows process census scope", () => {
  it("queries only the three exact fixture PIDs and returns only identity fields", () => {
    const command = censusCommand({ root: 17, markerParent: 23, readyGrandchild: 41 });
    expect(command).toContain("-Filter 'ProcessId = 17 OR ProcessId = 23 OR ProcessId = 41'");
    expect(command).toContain("Select-Object ProcessId, ParentProcessId, Name");
    expect(command).not.toMatch(/CommandLine|ExecutablePath|Get-Process|ComputerName/i);
  });

  it("bounds both captured streams and records the real subprocess result", async () => {
    const result = await observeCommand(spawn(process.execPath, [
      "-e",
      "process.stdout.write('o'.repeat(10000)); process.stderr.write('e'.repeat(10000)); process.exitCode = 7",
    ], { shell: false, timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }));

    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("o".repeat(4096));
    expect(result.stderr).toBe("e".repeat(4096));
  });

  it.each([0, -1, NaN, Infinity, 1.5, 0x1_0000_0000])(
    "rejects invalid native PID %s without starting a probe",
    (pid) => {
      expect(() => censusCommand({ root: pid, markerParent: 23, readyGrandchild: 41 })).toThrow(
        "fixture-owned native PIDs",
      );
    },
  );
});

interface CensusScenario {
  name: string;
  run: (command: string, opts: SpawnOptions) => Promise<SpawnResult>;
  reasons: ("timeout" | "abort")[];
}

const streaming = (command: string, opts: SpawnOptions) =>
  runShellStreaming(command, { ...opts, maxBytes: 4096, maxLines: 20 });

const scenarios: CensusScenario[] = [
  { name: "runShell", run: runShell, reasons: ["timeout", "abort"] },
  { name: "runShellStreaming", run: streaming, reasons: ["timeout", "abort"] },
  { name: "benchmark-script", run: streaming, reasons: ["abort"] },
  {
    name: "checks-script",
    run: (command, opts) => runShell({ script: command }, opts),
    reasons: ["abort"],
  },
];

describe.each(scenarios)("$name native Windows ownership census", ({ name, run, reasons }) => {
  it.runIf(process.platform === "win32").each(reasons)(
    "records the owned actors before and after %s without changing the ownership implementation",
    async (reason) => {
      const directory = path.resolve(`.owned-census-${crypto.randomUUID()}`);
      mkdirSync(directory);
      const ready = path.join(directory, "ready");
      const parent = path.join(directory, "parent");
      const release = path.join(directory, "release");
      const marker = path.join(directory, "survived");

      const worker = [
        "const fs = require('node:fs')",
        "fs.writeFileSync('ready.writing', String(process.pid)); fs.renameSync('ready.writing','ready')",
        "const timer = setInterval(() => { if (fs.existsSync('release')) { clearInterval(timer); fs.writeFileSync('survived', 'alive') } }, 10)",
      ].join("; ");

      writeFileSync(
        path.join(directory, "marker.cjs"),
        `const fs=require('node:fs'); fs.writeFileSync('parent.writing',String(process.pid)); fs.renameSync('parent.writing','parent'); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: 'inherit' });`,
      );
      const nodeCommand = `${quote(process.execPath.replaceAll("\\", "/"))} marker.cjs`;
      mkdirSync(path.join(directory, ".auto"));
      writeFileSync(path.join(directory, ".auto", "measure.sh"), `${nodeCommand}\n`);
      writeFileSync(path.join(directory, ".auto", "checks.sh"), `${nodeCommand}\n`);

      const command = name === "benchmark-script"
        ? "bash .auto/measure.sh"
        : name === "checks-script"
          ? path.join(directory, ".auto", "checks.sh")
          : nodeCommand;

      let root: number | undefined;
      const controller = new AbortController();

      const control: ProcessControl = {
        platform: process.platform,
        kill: process.kill.bind(process),
        spawn,
        onWindowsStarted: (pid) => { root = pid; },
      };

      const pending = run(command, {
        cwd: directory,
        timeoutMs: reason === "timeout" ? 15_000 : 30_000,
        signal: controller.signal,
        processControl: control,
      });

      // Observe rejection immediately, but do not unblock the fixture until the after census.
      const settled = pending.then(
        (result) => ({ result }),
        (error: Error) => ({ error }),
      );

      let pids: OwnedPids | undefined;
      let before: Awaited<ReturnType<typeof ownedCensus>> | undefined;
      let after: Awaited<ReturnType<typeof ownedCensus>> | undefined;
      const failures: unknown[] = [];

      try {
        await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 1500 });

        if (root === undefined) throw new Error("Owned execution did not report its native root PID");

        pids = {
          root,
          markerParent: Number(readFileSync(parent, "utf-8")),
          readyGrandchild: Number(readFileSync(ready, "utf-8")),
        };
        before = await ownedCensus(pids);

        if (reason === "abort") controller.abort();

        const outcome = await within(settled, 16_000);

        if ("error" in outcome) throw outcome.error;
        after = await ownedCensus(pids);
        console.info("OWNED_PROCESS_CENSUS", JSON.stringify({
          runner: name,
          cancellation: reason,
          before,
          completion: outcome.result,
          after,
        }));
        writeFileSync(release, "");
        expect(before.probeError).toBeUndefined();
        expect(after.probeError).toBeUndefined();
        expect(before.actors.every((actor) => actor.identity !== null)).toBe(true);
        expect(after.actors.every((actor) => actor.identity === null)).toBe(true);
        expect(outcome.result.killed).toBe(true);
        expect(existsSync(marker)).toBe(false);
      } catch (error) {
        failures.push(error);
      } finally {
        controller.abort();
        writeFileSync(release, "");

        const cleanup = await Promise.allSettled([
          within(settled, 6000).then((outcome) => {
            if ("error" in outcome) throw outcome.error;
          }),
        ]);

        rmSync(directory, { recursive: true, force: true });

        for (const entry of cleanup) {
          if (entry.status === "rejected") failures.push(entry.reason);
        }
      }

      if (failures.length > 0) throw new AggregateError(failures, "Owned census assertion or fixture cleanup failed");
    },
    45_000,
  );
});
