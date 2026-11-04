import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const portable = process.platform === "win32" || process.argv.includes("--portable");

if (portable && process.env.PSTACK_REQUIRE_TLC === "1")
  throw new Error("PSTACK_REQUIRE_TLC=1 requires POSIX model-checking tests, not portable-only tests.");

if (process.env.PSTACK_REQUIRE_TLC === "1") {
  const jar = process.env.TLA2TOOLS;

  if (!jar || !fs.statSync(jar, { throwIfNoEntry: false })?.isFile())
    throw new Error("PSTACK_REQUIRE_TLC=1 requires TLA2TOOLS to name an existing tla2tools.jar.");
  const java = spawnSync(process.env.JAVA || "java", ["-version"], { encoding: "utf8" });

  if (java.error || java.status !== 0)
    throw new Error(`PSTACK_REQUIRE_TLC=1 requires existing Java: ${java.error?.message ?? java.stderr}`);
}

const portableFiles = new Set([
  "chart.test.ts",
  "messages.test.ts",
  "pipeline.test.ts",
  "render.test.ts",
  "runtime.test.ts",
]);

const files = fs.readdirSync(import.meta.dirname)
  .filter((name) => name.endsWith(".test.ts") && (!portable || portableFiles.has(name)))
  .sort()
  .map((name) => path.join(import.meta.dirname, name));

if (portable)
  console.log("Portable parser/compiler tests only; POSIX CLI supervision and live TLC tests are not_run.");

const result = spawnSync(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", "--test", ...files],
  { stdio: "inherit" },
);

if (result.error) throw result.error;

process.exit(result.status ?? 1);
