import type { OpenClawConfig } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { RuntimeEnv } from "../../runtime.js";
import { applyDefaultModelPrimaryUpdate, updateConfig } from "./shared.js";

export async function setDefaultModel(modelRaw: string): Promise<OpenClawConfig> {
  // Keep gateway and CLI model changes on the same canonical updater so aliases,
  // primary model, and allowed model entries stay in sync.
  return updateConfig((cfg) => {
    return applyDefaultModelPrimaryUpdate({ cfg, modelRaw, field: "model" });
  });
}

export async function modelsSetCommand(modelRaw: string, runtime: RuntimeEnv) {
  const updated = await setDefaultModel(modelRaw);

  logConfigUpdated(runtime);
  runtime.log(
    `Default model: ${resolveAgentModelPrimaryValue(updated.agents?.defaults?.model) ?? modelRaw}`,
  );
}
