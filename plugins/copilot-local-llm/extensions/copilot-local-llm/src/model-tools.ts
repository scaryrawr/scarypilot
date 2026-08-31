import type { CopilotSession } from "@github/copilot-sdk";
import type { ProviderModelConfig } from "@github/copilot-sdk";

export const LOCAL_MODEL_TOOLS = [
  "bash",
  "view",
  "apply_patch",
  "edit",
  "read_bash",
  "stop_bash",
  "list_bash",
  "rg",
  "grep",
  "glob",
  "web_search",
  "skill",
  "ask_user",
] as const;

export async function configureLocalModelTools(
  session: CopilotSession,
  models: ProviderModelConfig[],
): Promise<void> {
  const localModelIds = new Set(models.map(({ provider, id }) => `${provider}/${id}`));
  let unrestrictedTools: string[] | undefined;
  let usesLocalProfile = false;
  let updateQueue = Promise.resolve();

  const applyModelProfile = async (modelId: string | undefined) => {
    const shouldUseLocalProfile = modelId !== undefined && localModelIds.has(modelId);
    if (shouldUseLocalProfile === usesLocalProfile) {
      return;
    }

    if (shouldUseLocalProfile) {
      await session.rpc.tools.initializeAndValidate();
      const { tools } = await session.rpc.tools.getCurrentMetadata();
      if (!tools) {
        throw new Error("The runtime did not provide the current tool catalog");
      }
      unrestrictedTools = tools.map(({ name }) => name);
      await updateAvailableTools(session, [...LOCAL_MODEL_TOOLS]);
    } else if (unrestrictedTools) {
      await updateAvailableTools(session, unrestrictedTools);
    }

    usesLocalProfile = shouldUseLocalProfile;
  };

  const currentModel = await session.rpc.model.getCurrent();
  await applyModelProfile(currentModel.modelId);

  session.on("session.model_change", ({ data }) => {
    updateQueue = updateQueue
      .then(() => applyModelProfile(data.newModel))
      .catch(async (error: unknown) => {
        await session.log(`Failed to update tools for model ${data.newModel}: ${String(error)}`, {
          level: "warning",
          ephemeral: true,
        });
      });
  });
}

async function updateAvailableTools(session: CopilotSession, availableTools: string[]) {
  const result = await session.rpc.options.update({ availableTools });
  if (!result.success) {
    throw new Error("The runtime rejected the tool update");
  }
}
