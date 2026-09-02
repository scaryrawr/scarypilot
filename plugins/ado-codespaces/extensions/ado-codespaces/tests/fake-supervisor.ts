import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { SpawnFactory, SupervisorProcess } from "../src/supervisor-client.ts";

export class FakeSupervisor {
  readonly writes: string[] = [];
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdinEvents = new EventEmitter();
  readonly processEvents = new EventEmitter();
  readonly end = vi.fn();
  readonly kill = vi.fn(() => true);
  readonly spawn = vi.fn<SpawnFactory>(() => this.process);

  readonly process: SupervisorProcess = {
    stdin: {
      write: (data) => {
        this.writes.push(data);
        return true;
      },
      end: this.end,
      on: (event, listener) => this.stdinEvents.on(event, listener),
    },
    stdout: this.stdout,
    stderr: this.stderr,
    on: (event, listener) => this.processEvents.on(event, listener),
    kill: this.kill,
  };

  requests(): Array<{
    readonly id: string;
    readonly method: string;
    readonly params: Record<string, unknown>;
  }> {
    return this.writes.map((line) => JSON.parse(line));
  }

  send(message: unknown): void {
    this.stdout.emit("data", `${JSON.stringify(message)}\n`);
  }
}
