import { readFile, writeFile } from "node:fs/promises";

const [command, ...args] = process.argv.slice(2);

const mode = process.env.MEDIA_FIXTURE_MODE;

const input = args[args.indexOf("-i") + 1];

const output = args.at(-1);

if (command === "ffprobe") {
  const data = await readFile(output);

  const payload = data.toString("ascii", 0, 4) === "RIFF"
    ? {
      format: { duration: String(data.readUInt32LE(40) / 32000) },
      streams: [{ index: 0, codec_type: "audio", sample_rate: "16000", channels: data.readUInt16LE(22) }],
    }
    : JSON.parse(data.toString());

  console.log(JSON.stringify(payload));
} else if (args.includes("-version")) {
  console.log("ffmpeg fixture");
} else if (args.includes("-progress")) {
  const source = JSON.parse(await readFile(input, "utf8"));
  const index = Number(args[args.indexOf("-map") + 1].split(":")[1]);
  const duration = source.streams.find((stream) => stream.index === index).fixture_duration;
  console.log(`out_time_us=${duration * 1_000_000}\nprogress=${mode === "incomplete-extent" ? "continue" : "end"}`);
} else if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode === "diagnostics") {
  process.stdout.write("x".repeat(100_000));
  setInterval(() => {}, 1000);
} else if (mode === "fail-second-frame" && output.includes("f0001")) {
  console.error("fixture extraction failure");
  process.exitCode = 1;
} else if (output.endsWith(".wav")) {
  const duration = Number(args[args.indexOf("-t") + 1]);
  const data = Buffer.alloc(44 + Math.round(duration * 32000));
  data.write("RIFF");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(mode === "bad-audio" ? 2 : 1, 22);
  data.writeUInt32LE(16000, 24);
  data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(data.length - 44, 40);
  await writeFile(output, data, { flag: "wx" });
} else {
  const filter = args[args.indexOf("-vf") + 1];
  const dimensions = /scale=(\d+):(\d+)/.exec(filter);

  if (!dimensions) throw new Error("Expected bounded scale filter");
  await writeFile(output, JSON.stringify({
    format: {},
    streams: [{ index: 0, codec_type: "video", width: Number(dimensions[1]), height: Number(dimensions[2]) }],
    request: args,
  }), { flag: "wx" });
}
