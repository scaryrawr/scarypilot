import type { CopilotSession } from "@github/copilot-sdk";
import type { ProviderModelConfig } from "@github/copilot-sdk";

export const LOCAL_MODEL_EXCLUDED_TOOLS = [
  "task",
  "list_agents",
  "read_agent",
  "write_agent",
  "run_factory",
  "factories_manage",
] as const;

export async function configureLocalModelTools(
  session: CopilotSession,
  models: ProviderModelConfig[],
): Promise<void> {
  const localModelIds = new Set(models.map(({ provider, id }) => `${provider}/${id}`));
  let usesLocalProfile = false;
  let updateQueue = Promise.resolve();

  const applyModelProfile = async (modelId: string | undefined) => {
    const shouldUseLocalProfile = modelId !== undefined && localModelIds.has(modelId);
    if (shouldUseLocalProfile === usesLocalProfile) {
      return;
    }

    await updateExcludedTools(
      session,
      shouldUseLocalProfile ? [...LOCAL_MODEL_EXCLUDED_TOOLS] : [],
    );

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

async function updateExcludedTools(session: CopilotSession, excludedTools: string[]) {
  const result = await session.rpc.options.update({
    excludedTools,
    toolFilterPrecedence: "excluded",
  });
  if (!result.success) {
    throw new Error("The runtime rejected the tool update");
  }
}
