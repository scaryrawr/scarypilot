import { spawn } from "node:child_process";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

type LogLevel = "info" | "warning" | "error";

const JsonSchema = Type.Recursive((self) =>
  Type.Union([
    Type.Boolean(),
    Type.Null(),
    Type.Number(),
    Type.String(),
    Type.Array(self),
    Type.Record(Type.String(), self),
  ]),
);

export type JsonValue = Static<typeof JsonSchema>;

export interface SupervisorProcess {
  readonly stdin: {
    write(data: string): boolean;
    end(): void;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
  };
  readonly stdout: {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
  };
  readonly stderr: {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
  };
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(): boolean;
}

export type SpawnFactory = (command: string, args: readonly string[]) => SupervisorProcess;

export type SupervisorLogger = (message: string, level: LogLevel) => void | Promise<void>;

interface PendingResponse {
  readonly resolve: (result: JsonValue) => void;
  readonly reject: (error: Error) => void;
}

interface ProtocolError {
  readonly code: string;
  readonly context?: JsonValue;
  readonly message: string;
}

const ProtocolErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    context: Type.Optional(JsonSchema),
    message: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const ErrorResponseSchema = Type.Object(
  {
    error: ProtocolErrorSchema,
    id: Type.String({ minLength: 1 }),
    type: Type.Literal("response"),
  },
  { additionalProperties: false },
);

const ResultResponseSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    result: JsonSchema,
    type: Type.Literal("response"),
  },
  { additionalProperties: false },
);

const SupervisorEventSchema = Type.Object(
  {
    agent_id: Type.String({ minLength: 1 }),
    event: JsonSchema,
    sequence: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    type: Type.Literal("event"),
  },
  { additionalProperties: false },
);

const SupervisorMessageSchema = Type.Union([
  ErrorResponseSchema,
  ResultResponseSchema,
  SupervisorEventSchema,
]);

type SupervisorMessage = Static<typeof SupervisorMessageSchema>;
export type SupervisorEvent = Static<typeof SupervisorEventSchema>;

export type EventSubscriber = (event: SupervisorEvent) => void | Promise<void>;

const defaultSpawnFactory: SpawnFactory = (command, args) =>
  spawn(command, [...args], { stdio: "pipe" });

const SHUTDOWN_TIMEOUT_MS = 12_000;

function parseSupervisorMessage(value: unknown): SupervisorMessage {
  if (!Value.Check(SupervisorMessageSchema, value)) {
    throw new Error("message does not match the supervisor protocol");
  }
  return value;
}

function chunkText(chunk: unknown): string | undefined {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SupervisorRequestError extends Error {
  readonly code: string;
  readonly context?: JsonValue;

  constructor(error: ProtocolError) {
    super(`Supervisor request failed: ${error.message}`);
    this.name = "SupervisorRequestError";
    this.code = error.code;
    this.context = error.context;
  }
}

export class SupervisorClient {
  readonly child: SupervisorProcess | null;
  readonly pending = new Map<string, PendingResponse>();

  private readonly subscribers = new Set<EventSubscriber>();
  private readonly log: SupervisorLogger;
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private sawStderr = false;
  private acceptingRequests = true;
  private exited = false;
  private cleanupComplete = false;
  private shutdownPromise: Promise<void> | undefined;
  private failure: Error | undefined;

  constructor(
    options: {
      readonly spawnFactory?: SpawnFactory;
      readonly log?: SupervisorLogger;
    } = {},
  ) {
    this.log = options.log ?? (() => undefined);
    const spawnFactory = options.spawnFactory ?? defaultSpawnFactory;
    try {
      this.child = spawnFactory("gh", ["ado-codespaces", "agent", "serve"]);
      this.child.stdin.on("error", (error) => this.onStdinError(error));
      this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
      this.child.stderr.on("data", (chunk) => this.onStderr(chunk));
      this.child.on("error", (error) => this.onProcessError(error));
      this.child.on("exit", (code, signal) => this.onProcessExit(code, signal));
    } catch (error) {
      this.child = null;
      this.acceptingRequests = false;
      this.failure = new Error(`Supervisor could not start: ${errorMessage(error)}`);
      this.emitLog(this.failure.message, "error");
    }
  }

  request(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (!this.acceptingRequests) {
      return Promise.reject(new Error("Supervisor is not accepting requests"));
    }
    if (method.length === 0) {
      return Promise.reject(new Error("Supervisor method must be non-empty"));
    }

    const id = String(this.nextRequestId++);
    const child = this.child;
    if (!child) {
      return Promise.reject(new Error("Supervisor is unavailable"));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        reject(new Error(`Supervisor request could not be sent: ${errorMessage(error)}`));
      }
    });
  }

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    try {
      if (!this.exited && this.child && this.acceptingRequests) {
        const response = this.request("shutdown", {});
        this.acceptingRequests = false;
        await waitForShutdown(response, SHUTDOWN_TIMEOUT_MS);
      } else {
        this.acceptingRequests = false;
      }
    } finally {
      this.cleanup();
    }
  }

  private onStdout(chunk: unknown): void {
    const text = chunkText(chunk);
    if (text === undefined) {
      this.emitLog("Ignored non-text supervisor output", "warning");
      return;
    }
    this.stdoutBuffer += text;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length > 0) this.handleLine(line);
    }
  }

  private onStderr(chunk: unknown): void {
    const text = chunkText(chunk);
    if (text === undefined) {
      this.emitLog("Ignored non-text supervisor stderr output", "warning");
      return;
    }
    if (!this.sawStderr) {
      this.sawStderr = true;
      this.emitLog("Supervisor wrote diagnostics to stderr", "warning");
    }
  }

  private handleLine(line: string): void {
    let message: SupervisorMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      message = parseSupervisorMessage(parsed);
    } catch (error) {
      this.emitLog(`Ignored invalid supervisor message: ${errorMessage(error)}`, "warning");
      return;
    }

    if (message.type === "event") {
      this.routeEvent(message);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      this.emitLog(`Ignored supervisor response for unknown request ${message.id}`, "warning");
      return;
    }
    this.pending.delete(message.id);
    if ("error" in message) {
      pending.reject(new SupervisorRequestError(message.error));
      return;
    }
    pending.resolve(message.result);
  }

  private routeEvent(event: SupervisorEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        void Promise.resolve(subscriber(event)).catch((error) => {
          this.emitLog(`Supervisor event subscriber failed: ${errorMessage(error)}`, "warning");
        });
      } catch (error) {
        this.emitLog(`Supervisor event subscriber failed: ${errorMessage(error)}`, "warning");
      }
    }
  }

  private onProcessError(error: unknown): void {
    this.acceptingRequests = false;
    this.failure ??= new Error(`Supervisor process failed: ${errorMessage(error)}`);
    this.rejectPending(this.failure);
    this.cleanup();
  }

  private onStdinError(error: unknown): void {
    this.onProcessError(new Error(`Supervisor stdin failed: ${errorMessage(error)}`));
  }

  private onProcessExit(code: unknown, signal: unknown): void {
    this.exited = true;
    this.acceptingRequests = false;
    const exitCode = typeof code === "number" || code === null ? code : "unknown";
    const exitSignal = typeof signal === "string" || signal === null ? signal : "unknown";
    this.failure ??= new Error(
      `Supervisor exited before responding (code=${String(exitCode)}, signal=${String(exitSignal)})`,
    );
    this.rejectPending(this.failure);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private cleanup(): void {
    if (this.cleanupComplete) return;
    this.cleanupComplete = true;
    this.acceptingRequests = false;
    const child = this.child;
    if (!child) {
      this.rejectPending(new Error("Supervisor shut down before responding"));
      return;
    }
    try {
      child.stdin.end();
    } catch (error) {
      this.emitLog(`Supervisor stdin cleanup failed: ${errorMessage(error)}`, "warning");
    }
    if (!this.exited) {
      try {
        child.kill();
      } catch (error) {
        this.emitLog(`Supervisor process cleanup failed: ${errorMessage(error)}`, "warning");
      }
    }
    this.rejectPending(new Error("Supervisor shut down before responding"));
  }

  private emitLog(message: string, level: LogLevel): void {
    void Promise.resolve()
      .then(() => this.log(message, level))
      .catch(() => undefined);
  }
}

function waitForShutdown(response: Promise<unknown>, timeoutMilliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMilliseconds);
    void response.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
