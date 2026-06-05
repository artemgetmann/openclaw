import type { OpenClawConfig } from "../config/config.js";

export async function runStatusJsonDeepSecurityAudit(params: {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
}) {
  const { runSecurityAudit } = await import("../security/audit.runtime.js");
  return await runSecurityAudit({
    config: params.config,
    sourceConfig: params.sourceConfig,
    deep: false,
    includeFilesystem: true,
    includeChannelSecurity: true,
  });
}
