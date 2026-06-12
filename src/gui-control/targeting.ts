import type { AppTarget, GuiSnapshot } from "./types.js";

export function guiTargetMatchesSnapshot(target: AppTarget, snapshot: GuiSnapshot): boolean {
  if (snapshot.appName.toLowerCase() !== target.appName.toLowerCase()) {
    return false;
  }
  if (target.windowId && snapshot.windowId && snapshot.windowId !== target.windowId) {
    return false;
  }
  if (!target.windowTitle) {
    return true;
  }
  return (snapshot.windowTitle ?? "").toLowerCase().includes(target.windowTitle.toLowerCase());
}

export function describeGuiTargetMismatch(target: AppTarget, snapshot: GuiSnapshot): string {
  return `Wrong target: requested ${target.appName}/${target.windowId ?? target.windowTitle ?? "any window"}, observed ${
    snapshot.appName
  }/${snapshot.windowId ?? snapshot.windowTitle ?? "unknown window"}.`;
}
