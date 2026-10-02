import { execFile } from "node:child_process";
import { realpathSync, existsSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import { type TSchema, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  CaptureDiagnosticsSchema, DeviceDiscoverySchema, DiagnosticsInputSchema,
  RecordingStateSchema, RecordingTargetSchema, StartRecordingInputSchema, StopRecordingInputSchema,
  WindowsDiscoverySchema,
  type RecordingTarget, type StartRecordingInput, type StopRecordingInput,
} from "./domain.ts";

export interface RecorderRuntime {
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function defaultRuntime(): RecorderRuntime {
  return {
    script: fileURLToPath(new URL("../../../skills/screen-record/scripts/screen-record.mjs", import.meta.url)),
    cwd: process.cwd(),
    env: process.env,
  };
}

export function runRecorder<S extends TSchema>(
  runtime: RecorderRuntime, args: string[], timeout: number, schema: S, signal?: AbortSignal,
): Promise<Static<S>> {
  return new Promise((accept, reject) => {
    execFile("node", [runtime.script, ...args], {
      cwd: runtime.cwd, env: runtime.env, timeout, maxBuffer: 262144, windowsHide: true, signal,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(
          `${stderr.trim() || error.message}\nCommand ${args[0]} failed. If start or stop was interrupted, run screen_record_status before retrying. Detached recordings are not killed by this tool.`,
        ));

        return;
      }

      try {
        const result: unknown = JSON.parse(stdout);

        if (!Value.Check(schema, result)) throw new Error("Recorder returned an unsupported result shape; inspect the CLI and extension versions.");
        accept(result);
      } catch (error) {
        reject(new Error(`Recorder returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

function workspaceOutput(runtime: RecorderRuntime, value: string): string {
  const root = realpathSync(runtime.cwd);
  const output = resolve(runtime.cwd, value);

  if (lstatSync(output, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("Output leaf symlinks are not allowed, including dangling symlinks. Choose a regular workspace file path.");
  }

  let ancestor = dirname(output);

  while (!existsSync(ancestor)) ancestor = dirname(ancestor);

  const canonical = existsSync(output)
    ? realpathSync(output)
    : resolve(realpathSync(ancestor), relative(ancestor, output));

  const fromRoot = relative(root, canonical);

  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Choose an output file inside the user's workspace. Parent-directory and symlink escapes are not allowed.");
  }

  return canonical;
}

function targetArgs(runtime: RecorderRuntime, input: RecordingTarget): string[] {
  workspaceOutput(runtime, input.output);

  return [
    "--output", resolve(runtime.cwd, input.output),
    ...(input.recordingId ? ["--recording-id", input.recordingId] : []),
  ];
}

function startArgs(runtime: RecorderRuntime, input: StartRecordingInput): string[] {
  if (input.audioDevice && !input.audioApproved) {
    throw new Error("Audio capture requires the user's explicit request and audioApproved=true.");
  }

  if (input.windowId && process.platform !== "win32") {
    throw new Error("Window capture is only supported on Windows.");
  }

  if (input.windowId && (input.videoInput !== undefined || input.region !== undefined)) {
    throw new Error("windowId cannot be combined with videoInput or region; choose a window or desktop capture.");
  }

  const args = ["start", "--output", workspaceOutput(runtime, input.output)];

  for (const [flag, value] of [
    ["fps", input.fps], ["video-input", input.videoInput], ["audio-device", input.audioDevice],
  ] as const) {
    if (value !== undefined) {
      if (String(value).startsWith("--")) throw new Error(`Invalid ${flag}: values cannot begin with --.`);
      args.push(`--${flag}`, String(value));
    }
  }

  if (input.region) {
    const { x, y, width, height } = input.region;
    args.push("--region", `${x},${y},${width},${height}`);
  }

  if (input.windowId) args.push("--window-id", input.windowId);

  return args;
}

function tool<I extends TSchema, O extends TSchema>(
  runtime: RecorderRuntime, name: string, description: string, input: I, output: O,
  command: (args: Static<I>) => { args: string[]; timeout: number },
): Tool {
  return {
    name, description, parameters: input,
    handler: async (args, invocation): Promise<ToolResultObject> => {
      try {
        if (!Value.Check(input, args)) {
          throw new Error(`Invalid tool input: ${[...Value.Errors(input, args)].map((error) => `${error.path} ${error.message}`).join("; ")}`);
        }

        const request = command(args);
        const result = await runRecorder(runtime, request.args, request.timeout, output, invocation.signal);

        return { resultType: "success", textResultForLlm: JSON.stringify(result) };
      } catch (error) {
        return {
          resultType: "failure",
          textResultForLlm: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export function createRecordingTools(runtime: RecorderRuntime = defaultRuntime()) {
  return [
    tool(runtime, "screen_record_doctor",
      "Check local FFmpeg/FFprobe and capture backend availability with bounded subprocesses. Does not capture, contact narration services, or verify OS privacy permission.",
      DiagnosticsInputSchema, CaptureDiagnosticsSchema,
      () => ({ args: ["doctor", "--capture-only"], timeout: 12000 })),
    tool(runtime, "screen_record_windows",
      "List visible, non-minimized, non-cloaked top-level windows on Windows for selected-window capture. Titles, process names, process IDs, and bounds are returned to help choose a target; titles may contain private document names. Does not capture, change focus, or verify capture permission. Pass a returned windowId to screen_record_start; requires an FFmpeg build with gdigrab HWND support.",
      DiagnosticsInputSchema, WindowsDiscoverySchema,
      () => ({ args: ["windows", "--json"], timeout: 15000 })),
    tool(runtime, "screen_record_devices",
      "List local capture inputs. AVFoundation/DirectShow discovery can trigger an OS permission prompt; do not grant it or bypass privacy controls without user approval. Listing does not prove capture permission.",
      DiagnosticsInputSchema, DeviceDiscoverySchema,
      () => ({ args: ["devices", "--json"], timeout: 7000 })),
    tool(runtime, "screen_record_start",
      "Start a detached screen recording only after the user's explicit capture request. Require separate audio approval when audioDevice is set. Preserve sources; never overwrite output. Returns persistent recordingId and log/state paths. The recording survives tool cancellation and extension/session restart. On interruption, query status before retrying. Does not drive apps or grant OS permissions.",
      StartRecordingInputSchema, RecordingStateSchema,
      (input) => ({ args: startArgs(runtime, input), timeout: input.windowId ? 30000 : 8000 })),
    tool(runtime, "screen_record_status",
      "Read persistent recording state by output, optionally checking recordingId. Use after tool cancellation or extension restart with the retained recordingId when available; do not adopt a replacement recording's ID. Reports stale state without killing processes.",
      RecordingTargetSchema, RecordingStateSchema,
      (input) => ({ args: ["status", ...targetArgs(runtime, input)], timeout: 3000 })),
    tool(runtime, "screen_record_stop",
      "Gracefully stop the identified recording through FFmpeg stdin and retain its final state. Requires the recordingId retained from start, or recovered through status only after confirming it is the intended recording. Do not adopt a replacement recording's ID. Idempotent after successful stop. Timeout leaves the recording alone; inspect status/logs and obtain user approval before any manual recovery. Never force-kills.",
      StopRecordingInputSchema, RecordingStateSchema,
      (input: StopRecordingInput) => ({
        args: ["stop", ...targetArgs(runtime, input), "--timeout", String(input.timeoutSeconds ?? 20)],
        timeout: ((input.timeoutSeconds ?? 20) + 2) * 1000,
      })),
  ];
}
