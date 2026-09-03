import { describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => {
  const stdoutListeners = new Map<string, Listener>();
  const stderrListeners = new Map<string, Listener>();
  const processListeners = new Map<string, Listener>();
  const writes: string[] = [];
  const stdout = {
    on: vi.fn((event: string, listener: Listener) => {
      stdoutListeners.set(event, listener);
    }),
  };
  const stderr = {
    on: vi.fn((event: string, listener: Listener) => {
      stderrListeners.set(event, listener);
    }),
  };
  const child = {
    stdin: {
      write: vi.fn((line: string) => {
        writes.push(line);
        return true;
      }),
      end: vi.fn(),
      on: vi.fn(),
    },
    stdout,
    stderr,
    on: vi.fn((event: string, listener: Listener) => {
      processListeners.set(event, listener);
    }),
    kill: vi.fn(() => true),
  };
  return {
    child,
    joinSession: vi.fn(async () => ({ log: vi.fn() })),
    options: undefined as
      | {
          hooks: { onSessionEnd: () => Promise<void> };
          tools: Array<{ name: string }>;
        }
      | undefined,
    spawn: vi.fn(() => child),
    stdoutListeners,
    writes,
  };
});

vi.mock("@github/copilot-sdk/extension", () => ({
  joinSession: async (options: typeof mocks.options) => {
    mocks.options = options;
    return mocks.joinSession();
  },
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

describe("extension", () => {
  it("registers every tool and shuts down the supervisor when the session ends", async () => {
    await import("../src/extension.ts");

    expect(mocks.options?.tools.map((tool) => tool.name)).toEqual([
      "codespaces_list",
      "codespaces_status",
      "codespaces_start",
      "codespaces_stop",
      "agent_start",
      "agent_send",
      "agent_status",
      "agent_stop",
      "agent_events",
    ]);

    const ending = mocks.options?.hooks.onSessionEnd();
    expect(JSON.parse(mocks.writes[0])).toEqual({
      id: "1",
      method: "shutdown",
      params: {},
    });
    mocks.stdoutListeners.get("data")?.(
      Buffer.from('{"type":"response","id":"1","result":null}\n'),
    );
    await ending;

    expect(mocks.child.stdin.end).toHaveBeenCalledOnce();
    expect(mocks.child.kill).toHaveBeenCalledOnce();
  });
});
