import os from "node:os";
import path from "node:path";

function resolveHostUserHomeDir(): string {
  try {
    // Existing-session Chrome attach must target the operator's real account
    // home, not a cleanroom HOME override that only exists to isolate OpenClaw
    // config/state. os.userInfo().homedir reads the account record directly.
    const hostHome = os.userInfo().homedir?.trim();
    if (hostHome) {
      return path.resolve(hostHome);
    }
  } catch {
    // Fall back to the process home when the account record is unavailable.
  }
  return path.resolve(os.homedir());
}

export function resolveHostChromeUserDataDir(platform: NodeJS.Platform = process.platform): string {
  const hostHome = resolveHostUserHomeDir();
  if (platform === "darwin") {
    return path.join(hostHome, "Library", "Application Support", "Google", "Chrome");
  }
  if (platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() || path.join(hostHome, "AppData", "Local");
    return path.join(localAppData, "Google", "Chrome", "User Data");
  }
  return path.join(hostHome, ".config", "google-chrome");
}
