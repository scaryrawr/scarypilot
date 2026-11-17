import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

const directory = process.env.PSTACK_FORGE_FIXTURE_DIR;

if (!directory) throw new Error("Missing forge fixture directory");

const tool = basename(process.execPath).replace(/\.exe$/i, "");
const args = process.argv.slice(2);
const read = (name) => readFileSync(join(directory, name), "utf8");

if (tool === "ssh" && existsSync(join(directory, "ssh-config"))) {
  const result = spawnSync(read("ssh-native"), ["-F", read("ssh-config"), ...args], {
    encoding: "utf8",
  });

  if (result.error) throw result.error;

  if (result.status === null) throw new Error(`SSH fixture terminated: ${result.signal}`);

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status);
}

if (tool !== "ssh" && realpathSync(process.cwd()) !== read("repository")) {
  throw new Error(`${tool} ran outside the fixture repo: ${process.cwd()}`);
}

const command = args.join(" ");
const key = createHash("sha256").update(`${tool}\0${command}`).digest("hex");
const response = join(directory, "responses", key);

if (existsSync(response)) {
  process.stdout.write(readFileSync(response, "utf8"));
} else if (tool === "gh" && args[0] === "pr" && args[1] === "list"
  && args.at(-2) === "--repo" && args.at(-1) === `${read("hostname")}/contributor/project`) {
  process.stdout.write("[]\n");
} else {
  process.stderr.write(`unexpected ${tool} arguments: ${command}\n`);
  process.exit(2);
}
