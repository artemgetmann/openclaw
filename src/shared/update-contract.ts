/** Stable update notification shared by the gateway runtime and control UI. */
export type UpdateAvailable = {
  currentVersion: string;
  latestVersion: string;
  channel: string;
};

/** Wire event name for update availability notifications. */
export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;

/** Wire payload for update availability notifications. */
export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailable | null;
};
