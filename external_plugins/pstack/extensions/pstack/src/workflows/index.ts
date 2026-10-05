import type { CwdRef } from "../extension-context.ts";
import { createPstackSwarmWorkflow, pstackSwarmWorkerAgent } from "./swarm.ts";

export function createPstackWorkflows(cwdRef: CwdRef) {
  return [createPstackSwarmWorkflow(cwdRef)];
}

export const pstackWorkflowAgents = [pstackSwarmWorkerAgent];
