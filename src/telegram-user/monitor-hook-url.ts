export function resolveLocalTelegramMonitorHookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new Error(`Telegram user monitor-poll requires a valid --hook-url: ${String(err)}`, {
      cause: err,
    });
  }
  const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopbackHosts.has(url.hostname)) {
    throw new Error("Telegram user monitor-poll --hook-url must point to the local gateway.");
  }
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (!normalizedPath.endsWith("/telegram-user-monitor-event")) {
    throw new Error(
      "Telegram user monitor-poll --hook-url must target a telegram-user-monitor-event hook.",
    );
  }
  url.pathname = normalizedPath;
  return url.toString();
}
