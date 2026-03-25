import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelsReadinessResult } from "../types.ts";

export type ModelReadinessState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  aiReadinessLoading: boolean;
  aiReadinessResult: ModelsReadinessResult | null;
  aiReadinessError: string | null;
};

function toErrorMessage(err: unknown): string {
  if (typeof err === "string" && err.trim()) {
    return err;
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return "request failed";
}

export async function loadModelReadiness(state: ModelReadinessState) {
  const client = state.client;
  if (!client || !state.connected || state.aiReadinessLoading) {
    return;
  }
  state.aiReadinessLoading = true;
  state.aiReadinessError = null;
  try {
    state.aiReadinessResult = await client.request<ModelsReadinessResult>("models.readiness", {});
  } catch (err) {
    state.aiReadinessError = toErrorMessage(err);
    state.aiReadinessResult = null;
  } finally {
    state.aiReadinessLoading = false;
  }
}
