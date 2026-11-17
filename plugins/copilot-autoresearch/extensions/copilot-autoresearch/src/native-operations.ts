import type { ToolInvocation } from "@github/copilot-sdk";
import type { OperationContext } from "./operations.ts";
import { broadcastDashboardUpdate } from "./dashboard.ts";
import { resolveWorkDir } from "./paths.ts";
import { savePersistedRuntime } from "./state.ts";
import type { RuntimeState } from "./state.ts";

export type NativeContext = Pick<OperationContext, "cwdRef" | "log" | "progress" | "onLogged"> & {
  runtime: RuntimeState;
};

export function nativeContext(ctx: NativeContext, invocation: ToolInvocation): OperationContext {
  return {
    ...ctx,
    git: "automatic",
    changed: broadcastDashboardUpdate,
    persist: () => savePersistedRuntime(
      resolveWorkDir(ctx.cwdRef.get()), invocation.sessionId, ctx.runtime,
    ),
  };
}
