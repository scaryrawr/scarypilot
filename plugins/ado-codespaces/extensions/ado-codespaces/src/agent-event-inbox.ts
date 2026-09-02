import type { SupervisorEvent } from "./supervisor-client.ts";

export interface AgentEventsRequest {
  readonly agentId: string;
  readonly afterSequence?: number;
  readonly waitMs: number;
}

export interface AgentEventsResult {
  readonly agent_id: string;
  readonly events: readonly SupervisorEvent[];
  readonly dropped: {
    readonly count: number;
    readonly first_sequence: number;
    readonly last_sequence: number;
  } | null;
}

interface Waiter {
  readonly request: AgentEventsRequest;
  readonly resolve: (result: AgentEventsResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface AgentBuffer {
  events: SupervisorEvent[];
  dropped: AgentEventsResult["dropped"];
  waiters: Set<Waiter>;
}

export class AgentEventInbox {
  private readonly buffers = new Map<string, AgentBuffer>();
  private readonly capacity: number;
  private closed = false;

  constructor(capacity = 100) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("Event inbox capacity must be a positive safe integer");
    }
    this.capacity = capacity;
  }

  add(event: SupervisorEvent): void {
    if (this.closed) return;
    const buffer = this.buffer(event.agent_id);
    buffer.events.push(event);
    buffer.events.sort((left, right) => left.sequence - right.sequence);
    while (buffer.events.length > this.capacity) {
      this.recordDrop(buffer, buffer.events.shift() as SupervisorEvent);
    }
    this.resolveReadyWaiters(buffer);
  }

  drain(request: AgentEventsRequest): Promise<AgentEventsResult> {
    const buffer = this.buffer(request.agentId);
    if (this.closed || this.hasAvailable(buffer, request.afterSequence) || request.waitMs === 0) {
      return Promise.resolve(this.take(buffer, request));
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        request,
        resolve,
        timer: setTimeout(() => {
          buffer.waiters.delete(waiter);
          resolve(this.take(buffer, request));
        }, request.waitMs),
      };
      buffer.waiters.add(waiter);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const buffer of this.buffers.values()) {
      for (const waiter of buffer.waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(this.take(buffer, waiter.request));
      }
      buffer.waiters.clear();
    }
  }

  private buffer(agentId: string): AgentBuffer {
    let buffer = this.buffers.get(agentId);
    if (!buffer) {
      buffer = { events: [], dropped: null, waiters: new Set() };
      this.buffers.set(agentId, buffer);
    }
    return buffer;
  }

  private hasAvailable(buffer: AgentBuffer, afterSequence: number | undefined): boolean {
    return (
      buffer.events.some(
        (event) => afterSequence === undefined || event.sequence > afterSequence,
      ) ||
      (buffer.dropped !== null &&
        (afterSequence === undefined || buffer.dropped.last_sequence > afterSequence))
    );
  }

  private take(buffer: AgentBuffer, request: AgentEventsRequest): AgentEventsResult {
    const events = buffer.events.filter(
      (event) => request.afterSequence === undefined || event.sequence > request.afterSequence,
    );
    buffer.events = [];
    const dropped = buffer.dropped;
    buffer.dropped = null;
    return { agent_id: request.agentId, events, dropped };
  }

  private recordDrop(buffer: AgentBuffer, event: SupervisorEvent): void {
    const previous = buffer.dropped;
    buffer.dropped = previous
      ? {
          count: previous.count + 1,
          first_sequence: Math.min(previous.first_sequence, event.sequence),
          last_sequence: Math.max(previous.last_sequence, event.sequence),
        }
      : {
          count: 1,
          first_sequence: event.sequence,
          last_sequence: event.sequence,
        };
  }

  private resolveReadyWaiters(buffer: AgentBuffer): void {
    for (const waiter of buffer.waiters) {
      if (!this.hasAvailable(buffer, waiter.request.afterSequence)) continue;
      buffer.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(this.take(buffer, waiter.request));
    }
  }
}
