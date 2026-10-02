import { Type, type Static } from "@sinclair/typebox";

const Text = Type.String({ minLength: 1, maxLength: 4096 });

const Platform = Type.Union([Type.Literal("darwin"), Type.Literal("linux"), Type.Literal("win32")]);

const CaptureDevice = Type.Union([Type.Literal("avfoundation"), Type.Literal("x11grab"), Type.Literal("gdigrab")]);

export const DiagnosticsInputSchema = Type.Object({}, { additionalProperties: false });

export const RecordingTargetSchema = Type.Object({
  output: Text,
  recordingId: Type.Optional(Text),
}, { additionalProperties: false });

export type RecordingTarget = Static<typeof RecordingTargetSchema>;

export const StartRecordingInputSchema = Type.Object({
  output: Text,
  captureApproved: Type.Literal(true, { description: "The user explicitly requested this screen capture. This does not grant OS permission." }),
  audioApproved: Type.Optional(Type.Literal(true, { description: "The user explicitly requested audio capture. Required when audioDevice is set." })),
  fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
  videoInput: Type.Optional(Text),
  audioDevice: Type.Optional(Text),
  region: Type.Optional(Type.Object({
    x: Type.Integer(),
    y: Type.Integer(),
    width: Type.Integer({ minimum: 2, multipleOf: 2 }),
    height: Type.Integer({ minimum: 2, multipleOf: 2 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export type StartRecordingInput = Static<typeof StartRecordingInputSchema>;

export const StopRecordingInputSchema = Type.Object({
  output: Text,
  recordingId: Text,
  timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 120 })),
}, { additionalProperties: false });

export type StopRecordingInput = Static<typeof StopRecordingInputSchema>;

const SavedRecording = {
  output: Text,
  recordingId: Type.Optional(Text),
  workerPid: Type.Integer({ minimum: 1 }),
  ffmpegPid: Type.Integer({ minimum: 1 }),
  startedAt: Text,
  statePath: Text,
  logPath: Text,
  updatedAt: Type.Optional(Text),
};

export const RecordingStateSchema = Type.Union([
  Type.Object({ status: Type.Literal("not-recording"), output: Text }),
  Type.Object({
    ...SavedRecording,
    status: Type.Union([Type.Literal("recording"), Type.Literal("stopping"), Type.Literal("stale")]),
  }),
  Type.Object({
    ...SavedRecording,
    status: Type.Union([Type.Literal("stopped"), Type.Literal("failed")]),
    endedAt: Text,
    exitCode: Type.Integer(),
  }),
]);

export type RecordingState = Static<typeof RecordingStateSchema>;

export const CaptureDiagnosticsSchema = Type.Object({
  platform: Platform,
  ffmpeg: Type.Boolean(),
  ffprobe: Type.Boolean(),
  captureDevice: CaptureDevice,
  captureAvailable: Type.Boolean(),
  permissionsVerified: Type.Literal(false),
});

export type CaptureDiagnostics = Static<typeof CaptureDiagnosticsSchema>;

export const DeviceDiscoverySchema = Type.Object({
  platform: Platform,
  captureDevice: Type.Union([Type.Literal("avfoundation"), Type.Literal("x11grab"), Type.Literal("dshow")]),
  listing: Type.String({ maxLength: 262144 }),
  permissionsVerified: Type.Literal(false),
});

export type DeviceDiscovery = Static<typeof DeviceDiscoverySchema>;
