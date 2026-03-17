import type { RuntimeEnv } from "../runtime.js";
import { healthCommand } from "./health.js";
import { waitForGatewayReachable } from "./onboard-helpers.js";

export async function runGatewayReachabilityHealthWorkflow(params: {
  runtime: RuntimeEnv;
  wsUrl: string;
  token?: string;
  password?: string;
  deadlineMs: number;
  onHealthFailure?: (err: unknown) => void | Promise<void>;
}): Promise<{ ok: boolean; detail?: string }> {
  const probe = await waitForGatewayReachable({
    url: params.wsUrl,
    token: params.token,
    password: params.password,
    deadlineMs: params.deadlineMs,
  });
  if (!probe.ok) {
    return probe;
  }

  try {
    await healthCommand({ json: false, timeoutMs: 10_000 }, params.runtime);
  } catch (err) {
    if (!params.onHealthFailure) {
      throw err;
    }
    await params.onHealthFailure(err);
  }

  return probe;
}
