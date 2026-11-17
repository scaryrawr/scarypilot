#!/usr/bin/env node
import { createRequire } from "node:module"; const require = createRequire(import.meta.url);

// skills/statechart/scripts/statechart.ts
import { spawn as spawn2 } from "node:child_process";
import fs2 from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

// skills/statechart/scripts/run.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import { inspect } from "node:util";

// skills/statechart/scripts/ir.ts
var EC = {
  TLC_INVARIANT_VIOLATED_INITIAL: 2107,
  TLC_PROPERTY_VIOLATED_INITIAL: 2108,
  TLC_INVARIANT_VIOLATED_BEHAVIOR: 2110,
  TLC_ACTION_PROPERTY_VIOLATED_BEHAVIOR: 2112,
  TLC_DEADLOCK_REACHED: 2114,
  TLC_TEMPORAL_PROPERTY_VIOLATED: 2116,
  TLC_BACK_TO_STATE: 2122,
  TLC_FINISHED: 2186,
  TLC_INIT_GENERATED1: 2190,
  TLC_INIT_GENERATED2: 2191,
  TLC_STATS: 2199,
  TLC_PROGRESS_STATS: 2200,
  TLC_STATE_PRINT2: 2217,
  TLC_STATE_PRINT3: 2218,
  TLC_SANY_END: 2219,
  TLC_SANY_START: 2220
};
var LEVEL = { NONE: 0, ERROR: 1, TLCBUG: 2, WARNING: 3, STATE: 4 };
var PART = 1 << 24;
var CHECK_DEADLOCK = "CHECK_DEADLOCK";

// skills/statechart/scripts/backends/plain-text.ts
var PREFIX = {
  [LEVEL.ERROR]: "Error: ",
  [LEVEL.TLCBUG]: "TLC Bug: ",
  [LEVEL.WARNING]: "Warning: ",
  [LEVEL.STATE]: "State "
};

// skills/statechart/scripts/frontends/config.ts
var SECTIONS = /* @__PURE__ */ new Map();
for (const section of [
  { key: "CONSTANT", plural: "CONSTANTS" },
  { key: CHECK_DEADLOCK, field: "checkDeadlock" },
  { key: "INIT", field: "init", undefinedNoun: "initial predicate" },
  { key: "NEXT", field: "next", undefinedNoun: "next state action" },
  { key: "SPECIFICATION", field: "spec", undefinedNoun: "name" },
  { key: "VIEW", field: "view", undefinedNoun: "view function" },
  { key: "SYMMETRY", field: "symmetry", undefinedNoun: "symmetry function" },
  { key: "TYPE", field: "type" },
  { key: "TYPE_CONSTRAINT", field: "typeConstraint" },
  { key: "INVARIANT", plural: "INVARIANTS", field: "invariants", undefinedNoun: "invariant" },
  { key: "PROPERTY", plural: "PROPERTIES", field: "properties", undefinedNoun: "property" },
  { key: "CONSTRAINT", plural: "CONSTRAINTS", field: "constraints", undefinedNoun: "constraint" },
  {
    key: "ACTION_CONSTRAINT",
    plural: "ACTION_CONSTRAINTS",
    field: "actionConstraints",
    undefinedNoun: "action constraint"
  }
]) {
  SECTIONS.set(section.key, section);
  if (section.plural) SECTIONS.set(section.plural, section);
}

// skills/statechart/scripts/frontends/value.ts
var BRACKET = new Int8Array(128);
for (const c of "<{[(") BRACKET[c.charCodeAt(0)] = 1;
for (const c of ">}])") BRACKET[c.charCodeAt(0)] = -1;

// skills/statechart/scripts/frontends/verdict.ts
var NAMED = /* @__PURE__ */ new Map([
  [EC.TLC_INVARIANT_VIOLATED_INITIAL, ["invariant", /^Invariant (.+) is violated by the initial/]],
  [EC.TLC_INVARIANT_VIOLATED_BEHAVIOR, ["invariant", /^Invariant (.+) is violated\.$/m]],
  [EC.TLC_PROPERTY_VIOLATED_INITIAL, ["property", /^Property (.+) is violated by the initial/]],
  [EC.TLC_ACTION_PROPERTY_VIOLATED_BEHAVIOR, ["property", /^Action property (.+) is violated\.$/m]]
]);
var DISTINCT = /* @__PURE__ */ new Map([
  [EC.TLC_INIT_GENERATED1, /(\d+) distinct states? generated/],
  [EC.TLC_INIT_GENERATED2, /with (\d+) of them distinct/],
  [EC.TLC_STATS, /(\d+) distinct states found/]
]);

// skills/statechart/scripts/run.ts
function requirePosix(platform = process.platform) {
  if (platform === "win32" || !fs.existsSync("/bin/sh"))
    throw new Error(
      "The statechart CLI requires POSIX /bin/sh and process groups; Windows is not supported. Use an approved POSIX environment. The pure parser and compiler tests remain portable."
    );
}
var killGroup = (pid) => new Promise(
  (resolve) => spawn("/bin/sh", ["-c", 'kill -s KILL -- "-$1"', "sh", String(pid)], { stdio: "ignore" }).on(
    "exit",
    resolve
  )
);
var messageOf = (error) => typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : inspect(error);
var utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

// skills/statechart/scripts/statechart.ts
var USAGE = `Usage: statechart SPEC.tla [--config FILE] [--view FILE] [--out DIR]

Checks SPEC.tla with TLC and draws its state graph as Mermaid. Above 500 states, the chart
draws only the paths to the rules that break, and with no rule broken there is no chart.mmd.
  --config FILE  TLC config. Default: SPEC.cfg beside the spec.
  --view FILE    A module that exports state(vars) and, if you want, step(action, from, to),
                 group(vars), colors, and title. state() returns a string for a flat chart, an
                 array for parent states, or an object for regions. Default: each state's values.
                 colors gives each group blue, orange, purple, yellow, teal, tan, or pink.
  --out DIR      Where to write report.md, chart.mmd, tlc.out, and tlc-RULE.out for each
                 property that breaks and each rule that breaks off the chart. The folder must
                 be new or empty. Default: SPEC-chart.
Exit code: TLC's own on the config as written: 0 when every rule holds, 1 when a rule breaks,
and 2 when TLC stops with an error, a signal kills the check, or the command cannot run. 130 or
143 when SIGINT or SIGTERM stops the check. Only exits 0 and 1 write output.`;
var stop;
var stopped = new Promise((resolve) => {
  for (const name of ["SIGINT", "SIGTERM"])
    process.on(name, () => {
      stop ??= name;
      resolve();
    });
});
var flags;
var specFile;
try {
  const args = parseArgs({
    allowPositionals: true,
    options: { config: { type: "string" }, view: { type: "string" }, out: { type: "string" } }
  });
  flags = args.values;
  [specFile] = args.positionals;
  if (args.positionals.length !== 1) throw new Error("Give one SPEC.tla.");
} catch (error) {
  console.error(`${messageOf(error)}

${USAGE}`);
  process.exit(2);
}
var codeOf = (error) => error instanceof Error && "code" in error ? error.code : void 0;
try {
  requirePosix();
  const configFile = flags.config ?? specFile.replace(/\.tla$/, ".cfg");
  if (!fs2.existsSync(configFile))
    throw new Error(`Cannot find the TLC config ${configFile}. Pass --config FILE.`);
  const out = flags.out ?? specFile.replace(/\.tla$/, "-chart");
  let entries = [];
  let dest;
  try {
    entries = fs2.readdirSync(out);
    dest = fs2.realpathSync(out);
  } catch (error) {
    if (codeOf(error) !== "ENOENT")
      throw new Error(
        `${out} cannot be the output folder. ${messageOf(error)}. Pass --out with a new folder.`,
        { cause: error }
      );
    if (fs2.lstatSync(out, { throwIfNoEntry: false }))
      throw new Error(
        `${out} cannot be the output folder. It is a broken link. Pass --out with a new folder.`,
        { cause: error }
      );
    dest = path.resolve(out);
  }
  if (entries.length)
    throw new Error(
      `${out} is not empty. It has ${entries.sort()[0]}. The command writes only to a new or empty folder. Pass --out with a new folder.`
    );
  let base = path.dirname(dest);
  while (!fs2.existsSync(base)) base = path.dirname(base);
  const stage = fs2.mkdtempSync(path.join(base, `.${path.basename(dest)}.statechart-`));
  const done = path.join(stage, "done");
  let tmp;
  let janitor;
  let exitCode;
  try {
    tmp = fs2.mkdtempSync(path.join(os.tmpdir(), "statechart-"));
    const runtime = process.versions.deno ? [
      "run",
      "--quiet",
      "--no-prompt",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env"
    ] : process.execArgv;
    const worker = spawn2(
      process.execPath,
      [
        ...runtime,
        path.join(import.meta.dirname, import.meta.url.endsWith(".mjs") ? "worker.mjs" : "worker.ts"),
        stage,
        specFile,
        configFile,
        ...flags.view ? [flags.view] : []
      ],
      {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, TMPDIR: tmp }
      }
    );
    const workerPid = worker.pid;
    if (workerPid === void 0) throw new Error("Cannot start the statechart worker.");
    janitor = spawn2(
      "/bin/sh",
      [
        "-c",
        'while read -r line; do :; done; kill -s KILL -- "-$1"; rm -rf -- "$2" "$3"',
        "sh",
        String(workerPid),
        stage,
        tmp
      ],
      { detached: true, stdio: ["pipe", "ignore", "ignore"] }
    );
    const exited = new Promise(
      (resolve) => worker.on("exit", (code) => resolve(code ?? 2))
    );
    await Promise.race([stopped, exited]);
    await killGroup(workerPid);
    const verdict = await exited;
    if (stop) {
      console.error(`${stop} stopped the check, so the command wrote nothing.`);
      exitCode = 128 + os.constants.signals[stop];
    } else if (worker.signalCode) {
      console.error(`${worker.signalCode} killed the check, so the command wrote nothing.`);
      exitCode = 2;
    } else if ((verdict === 0 || verdict === 1) && fs2.existsSync(done)) {
      fs2.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        fs2.renameSync(done, dest);
      } catch (error) {
        if (codeOf(error) !== "ENOTEMPTY" && codeOf(error) !== "EEXIST") throw error;
        throw new Error(
          `${path.join(out, fs2.readdirSync(dest).sort()[0])} appeared while the check ran, so the command wrote nothing. Pass --out with a new folder.`,
          { cause: error }
        );
      }
      process.stdout.write(fs2.readFileSync(path.join(dest, "report.md")));
      console.log(`
Wrote ${out}`);
      exitCode = verdict;
    } else exitCode = 2;
  } finally {
    fs2.rmSync(stage, { recursive: true, force: true });
    if (tmp) fs2.rmSync(tmp, { recursive: true, force: true });
    janitor?.kill("SIGKILL");
  }
  process.exit(exitCode);
} catch (error) {
  console.error(messageOf(error));
  process.exit(2);
}
