import type { OpenClawConfig } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { RuntimeEnv } from "../../runtime.js";
import { applyDefaultModelPrimaryUpdate, updateConfig } from "./shared.js";

export async function setDefaultModel(modelRaw: string): Promise<OpenClawConfig> {
  // Route every model change through the shared canonical updater so gateway,
  // CLI, and consumer UI all normalize aliases and maintain allowlist entries
  // the same way.
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
