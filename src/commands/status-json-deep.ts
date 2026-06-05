import type { RuntimeEnv } from "../runtime.js";
import { runStatusJsonDeepSecurityAudit } from "./status-json-deep-audit.js";
import { writeStatusJsonCommand } from "./status-json.js";

export async function statusJsonDeepCommand(
  opts: {
    usage?: boolean;
    timeoutMs?: number;
    all?: boolean;
  },
  runtime: RuntimeEnv,
) {
  await writeStatusJsonCommand({ ...opts, deep: true }, runtime, (scan) =>
    runStatusJsonDeepSecurityAudit({
      config: scan.cfg,
      sourceConfig: scan.sourceConfig,
    }),
  );
}
