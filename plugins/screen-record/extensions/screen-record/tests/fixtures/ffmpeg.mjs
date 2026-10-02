#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);

const mode = process.env.RECORDER_FIXTURE_MODE;

if (args.includes("-version")) {
  if (mode === "diagnostic-timeout") setTimeout(() => process.exit(0), 6000);
  else console.log("fixture FFmpeg 1.0");
} else if (args.includes("-devices")) {
  console.log(" D  avfoundation AVFoundation input\n D  x11grab X11 input\n D  gdigrab desktop input");
} else if (args.includes("-list_devices")) {
  if (mode === "device-enumeration-error-only") {
    console.error("Could not enumerate video devices (or none found).\nCould not enumerate audio devices (or none found).");
    process.exitCode = 1;
  } else if (mode === "device-failure") {
    console.error("fixture device enumeration failed");
    process.exitCode = 2;
  } else {
    console.error("AVFoundation video devices:\n[0] Fixture screen\nAVFoundation audio devices:\n[0] Fixture audio\nDirectShow video devices\n\"Fixture audio\" (audio)");
    process.exitCode = mode === "device-enumeration-eio" ? 251 : 1;
  }
} else {
  const output = args.at(-1);

  if (!args.includes("-n") || args.includes("-y")) throw new Error("Fixture requires no-overwrite capture arguments");

  if (mode === "argument-contract") writeFileSync(`${output}.args.json`, JSON.stringify(args));

  if (mode === "capture-failure") {
    console.error("fixture capture denied by OS permission");
    process.exit(3);
  }

  if (existsSync(output)) process.exit(4);
  writeFileSync(output, "fixture raw recording", { flag: "wx" });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (text) => {
    if (text.includes("q") && mode?.startsWith("heartbeat-")) {
      writeFileSync(`${output}.stop-requested`, "graceful stdin stop");
    }

    if (text.includes("q") && mode !== "slow-stop") process.exit(0);

    if (text.includes("q") && mode === "slow-stop") setTimeout(() => process.exit(0), 1200);
  });
  setTimeout(() => process.exit(0), 10000);
}
