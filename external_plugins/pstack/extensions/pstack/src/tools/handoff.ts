import type { Tool } from "@github/copilot-sdk";
import type { PstackService } from "../service.ts";
import { json, requiredString } from "./common.ts";

type HandoffArgs =
  | {
      action: "write";
      intent: string;
      progress: string;
      next_action: string;
      key_files?: string[];
      store_dir?: string;
      watch_files?: string[];
    }
  | {
      action: "read";
      path?: string;
    };

export function createHandoffTool(service: PstackService): Tool<HandoffArgs> {
  return {
    name: "pstack_handoff",
    description:
      "Write or read a durable, versioned pstack handoff under the repository Git state directory. Use this instead of /tmp notes or transcript-path assumptions.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["write", "read"] },
        intent: { type: "string" },
        progress: { type: "string" },
        next_action: { type: "string" },
        key_files: { type: "array", items: { type: "string" } },
        store_dir: { type: "string" },
        watch_files: { type: "array", items: { type: "string" } },
        path: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    handler: async (args, invocation) => {
      if (args.action === "read") return json(await service.readHandoff(args.path));
      return json(
        await service.writeHandoff(invocation.sessionId, {
          intent: requiredString(args.intent, "intent"),
          progress: requiredString(args.progress, "progress"),
          nextAction: requiredString(args.next_action, "next_action"),
          keyFiles: args.key_files ?? [],
          storeDir: args.store_dir,
          watchFiles: args.watch_files,
        }),
      );
    },
  };
}
