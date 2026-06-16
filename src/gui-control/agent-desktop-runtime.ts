import { runCommandWithTimeout, runExec } from "../process/exec.js";
import type {
  ActionResult,
  AppState,
  AppTarget,
  ElementRef,
  GuiRuntime,
  GuiSnapshot,
  WindowState,
} from "./types.js";

type AgentDesktopRuntimeOptions = {
  command?: string;
  baseArgs?: string[];
  timeoutMs?: number;
};

function firstString(value: unknown): string;
function firstString(value: unknown, fallback: string): string;
function firstString(value: unknown, fallback: undefined): string | undefined;
function firstString(value: unknown, fallback: string | undefined): string | undefined;
function firstString(value: unknown, fallback = ""): string | undefined {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function firstNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstNonEmptyString(...values: unknown[]): string {
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim());
  return typeof value === "string" ? value : "";
}

function readBounds(value: unknown): ElementRef["bounds"] {
  const record = asRecord(value);
  const x = firstNumber(record.x);
  const y = firstNumber(record.y);
  const width = firstNumber(record.width ?? record.w);
  const height = firstNumber(record.height ?? record.h);
  return x === undefined || y === undefined || width === undefined || height === undefined
    ? undefined
    : { x, y, width, height };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseJsonOutput(stdout: string, stderr: string): unknown {
  const raw = stdout.trim() || stderr.trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    const firstJsonLine = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("{") || line.startsWith("["));
    return firstJsonLine ? JSON.parse(firstJsonLine) : { text: raw };
  }
}

function normalizeSnapshotContent(
  raw: unknown,
  snapshotId: string,
  appName: string,
  windowTitle?: string,
): { elements: ElementRef[]; visibleText: string[] } {
  const candidates: Record<string, unknown>[] = [];
  const visibleText = new Set<string>();

  function collectText(record: Record<string, unknown>) {
    for (const key of ["value", "label", "name", "title", "description", "text"]) {
      const text = firstString(record[key], undefined);
      if (text) {
        visibleText.add(text);
      }
    }
  }

  function visit(value: unknown) {
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child);
      }
      return;
    }
    const record = asRecord(value);
    if (!Object.keys(record).length) {
      return;
    }
    collectText(record);

    // agent-desktop snapshots currently expose tree nodes with `ref_id`, while
    // some older/alternate JSON shapes expose flat `ref` or `id` fields. Keep
    // the parser tolerant so runtime upgrades do not silently drop the AX tree.
    if (record.ref || record.ref_id || record.id) {
      candidates.push(record);
    }
    visit(record.elements);
    visit(record.nodes);
    visit(record.children);
    visit(record.tree);
  }

  visit(raw);

  const elements = candidates
    .map((candidate) => {
      const name = firstString(candidate.name, undefined);
      const title = firstString(candidate.title, undefined);
      const description = firstString(candidate.description, undefined);
      const value = firstString(candidate.value, undefined);
      return {
        ref: firstString(candidate.ref ?? candidate.ref_id ?? candidate.id),
        snapshotId,
        role: firstString(candidate.role, undefined),
        name,
        title,
        label: firstNonEmptyString(candidate.label, name, title, description),
        description,
        value,
        bounds: readBounds(candidate.bounds ?? candidate.frame),
        appName,
        windowTitle,
      };
    })
    .filter((element) => element.ref);
  return { elements, visibleText: Array.from(visibleText).slice(0, 500) };
}

export function parseAgentDesktopSnapshot(raw: unknown, target: AppTarget): GuiSnapshot {
  const top = asRecord(raw);
  const payload = asRecord(top.data ?? raw);
  const windowRecord = asRecord(payload.window);
  const treeRecord = asRecord(payload.tree);
  const appName = firstString(
    payload.appName ?? payload.app ?? top.appName ?? top.app ?? target.appName,
    target.appName,
  );
  const windowTitle = firstString(
    payload.windowTitle ??
      windowRecord.title ??
      top.windowTitle ??
      treeRecord.name ??
      target.windowTitle,
    target.windowTitle,
  );
  const snapshotId = firstString(
    payload.snapshotId ?? payload.snapshot_id ?? top.snapshotId ?? top.id,
    `agent-desktop-${Date.now()}`,
  );
  const content = normalizeSnapshotContent(
    payload.elements ?? payload.nodes ?? payload.tree ?? payload,
    snapshotId,
    appName,
    windowTitle,
  );
  return {
    id: snapshotId,
    appName,
    windowId: firstString(
      windowRecord.id ?? windowRecord.window_id ?? windowRecord.windowId ?? target.windowId,
      target.windowId,
    ),
    windowTitle,
    summary: firstString(payload.summary ?? payload.text ?? treeRecord.description, undefined),
    visibleText: content.visibleText,
    raw,
    elements: content.elements,
  };
}

function readArrayPayload(raw: unknown, key: string): unknown[] {
  const top = asRecord(raw);
  const data = asRecord(top.data);
  const direct = top[key];
  const nested = data[key];
  if (Array.isArray(raw)) {
    return raw;
  }
  if (Array.isArray(top.data)) {
    return top.data;
  }
  if (Array.isArray(nested)) {
    return nested;
  }
  return Array.isArray(direct) ? direct : [];
}

export function parseAgentDesktopApps(appsRaw: unknown, windowsRaw?: unknown): AppState[] {
  const windows = parseAgentDesktopWindows(windowsRaw);
  const focusedWindow = windows.find((window) => window.focused);
  const focusedPid = focusedWindow ? firstNumber(focusedWindow.pid) : undefined;
  const focusedAppName = focusedWindow?.appName;

  return readArrayPayload(appsRaw, "apps").map((candidate: unknown): AppState => {
    const app = asRecord(candidate);
    const appName = firstString(app.appName ?? app.name ?? app.bundleName, "unknown");
    const pid = firstNumber(app.pid);
    const frontmost =
      typeof app.frontmost === "boolean"
        ? app.frontmost
        : Boolean(
            (focusedPid !== undefined && pid === focusedPid) ||
            (focusedAppName && appName === focusedAppName),
          );
    return {
      appName,
      pid,
      frontmost,
      windows: windows.filter(
        (window) =>
          (pid !== undefined && window.pid === pid) ||
          normalizeVisibleText(window.appName) === normalizeVisibleText(appName),
      ),
    };
  });
}

function normalizeVisibleText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function parseAgentDesktopWindows(raw: unknown): WindowState[] {
  return readArrayPayload(raw, "windows").map((candidate: unknown): WindowState => {
    const window = asRecord(candidate);
    return {
      id: firstString(window.id ?? window.window_id ?? window.windowId, undefined),
      appName: firstString(window.app_name ?? window.appName ?? window.name, "unknown"),
      pid: firstNumber(window.pid),
      title: firstString(window.title ?? window.name, undefined),
      focused: window.is_focused === true || window.focused === true,
    };
  });
}

export class AgentDesktopRuntime implements GuiRuntime {
  readonly name = "agent-desktop" as const;
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly timeoutMs: number;

  constructor(options: AgentDesktopRuntimeOptions = {}) {
    this.command = options.command ?? "npx";
    this.baseArgs = options.baseArgs ?? ["--yes", "agent-desktop"];
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async runJson(args: string[]): Promise<unknown> {
    const result = await runExec(this.command, [...this.baseArgs, ...args], {
      timeoutMs: this.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseJsonOutput(result.stdout, result.stderr);
  }

  private async runActionJson(args: string[]): Promise<{ ok: boolean; raw: unknown }> {
    const result = await runCommandWithTimeout([this.command, ...this.baseArgs, ...args], {
      timeoutMs: this.timeoutMs,
      noOutputTimeoutMs: this.timeoutMs,
    });
    return {
      ok: result.code === 0,
      raw: parseJsonOutput(result.stdout, result.stderr),
    };
  }

  async listApps(): Promise<AppState[]> {
    const appsRaw = await this.runJson(["list-apps"]);
    const windowsRaw = await this.runJson(["list-windows"]).catch(() => undefined);
    return parseAgentDesktopApps(appsRaw, windowsRaw);
  }

  async listWindows(): Promise<WindowState[]> {
    return parseAgentDesktopWindows(await this.runJson(["list-windows"]));
  }

  async focusWindow(target: WindowState): Promise<ActionResult> {
    const args = ["focus-window"];
    if (target.id) {
      args.push("--window-id", target.id);
    } else {
      args.push("--app", target.appName);
      if (target.title) {
        args.push("--title", target.title);
      }
    }
    const action = await this.runActionJson(args);
    const raw = action.raw;
    const record = asRecord(raw);
    return {
      ok: action.ok && record.ok !== false,
      movedFocus: true,
      raw,
      message: firstString(record.message, undefined),
    };
  }

  async openUrl(target: AppTarget, url: string): Promise<ActionResult> {
    const result = await runCommandWithTimeout(["open", "-a", target.appName, url], {
      timeoutMs: this.timeoutMs,
      noOutputTimeoutMs: this.timeoutMs,
    });
    return {
      ok: result.code === 0,
      actionCount: 1,
      movedFocus: true,
      message: result.stderr.trim() || result.stdout.trim() || undefined,
      raw: { stdout: result.stdout, stderr: result.stderr, code: result.code },
    };
  }

  async observe(target: AppTarget): Promise<GuiSnapshot> {
    const targetArgs = target.windowId
      ? ["--window-id", target.windowId]
      : ["--app", target.appName];
    const raw = await this.runJson(["snapshot", ...targetArgs, "-i", "--compact"]);
    return parseAgentDesktopSnapshot(raw, target);
  }

  async setValue(target: ElementRef, value: string): Promise<ActionResult> {
    const snapshotArgs = target.snapshotId ? ["--snapshot", target.snapshotId] : [];
    const shouldClearFirst = value === "" || Boolean(target.value?.trim());
    const clearAction = shouldClearFirst
      ? await this.runActionJson(["clear", target.ref, ...snapshotArgs])
      : undefined;
    // `set-value` is advisory-quality in Electron/WebKit text editors: Claude
    // can report success while leaving the composer untouched. `type` is still
    // element-scoped through AX refs, but it exercises the app's real text
    // input path, so the verifier can judge the visible post-state.
    //
    // Clearing mutates the text field and can invalidate agent-desktop's
    // snapshot binding even when the AX ref string remains stable. Use the
    // snapshot for the clear, then type against the live ref.
    const typeSnapshotArgs = clearAction ? [] : snapshotArgs;
    const action =
      value === ""
        ? { ok: true, raw: { skippedSetValueAfterClear: true } }
        : await this.runActionJson(["type", target.ref, ...typeSnapshotArgs, value]);
    const raw = action.raw;
    const record = asRecord(raw);
    const clearRecord = asRecord(clearAction?.raw);
    return {
      ok:
        action.ok &&
        record.ok !== false &&
        (clearAction === undefined || (clearAction.ok && clearRecord.ok !== false)),
      actionCount: shouldClearFirst && value !== "" ? 2 : 1,
      staleRef:
        Boolean(record.staleRef) ||
        Boolean(clearRecord.staleRef) ||
        /stale/i.test(firstString(record.error ?? clearRecord.error ?? record.message)),
      usedClipboard: Boolean(record.usedClipboard) || Boolean(clearRecord.usedClipboard),
      movedFocus: Boolean(record.movedFocus) || Boolean(clearRecord.movedFocus),
      raw: clearAction ? { clear: clearAction.raw, setValue: raw } : raw,
      message: firstString(record.message, undefined),
    };
  }

  async click(target: ElementRef): Promise<ActionResult> {
    const snapshotArgs = target.snapshotId ? ["--snapshot", target.snapshotId] : [];
    const action = await this.runActionJson(["click", target.ref, ...snapshotArgs]);
    const raw = action.raw;
    const record = asRecord(raw);
    return {
      ok: action.ok && record.ok !== false,
      staleRef:
        Boolean(record.staleRef) || /stale/i.test(firstString(record.error ?? record.message)),
      usedClipboard: Boolean(record.usedClipboard),
      movedFocus: Boolean(record.movedFocus),
      raw,
      message: firstString(record.message, undefined),
    };
  }

  async press(target: AppTarget, keys: string[]): Promise<ActionResult> {
    const action = await this.runActionJson(["press", "--app", target.appName, keys.join("+")]);
    const raw = action.raw;
    const record = asRecord(raw);
    return {
      ok: action.ok && record.ok !== false,
      staleRef: Boolean(record.staleRef),
      usedClipboard: Boolean(record.usedClipboard),
      movedFocus: true,
      raw,
      message: firstString(record.message, undefined),
    };
  }

  async scroll(
    target: ElementRef,
    options: { direction?: "up" | "down" | "left" | "right"; amount?: number } = {},
  ): Promise<ActionResult> {
    const snapshotArgs = target.snapshotId ? ["--snapshot", target.snapshotId] : [];
    const amount = Number.isFinite(options.amount) ? String(options.amount) : "3";
    const action = await this.runActionJson([
      "scroll",
      target.ref,
      ...snapshotArgs,
      "--direction",
      options.direction ?? "down",
      "--amount",
      amount,
    ]);
    const raw = action.raw;
    const record = asRecord(raw);
    return {
      ok: action.ok && record.ok !== false,
      staleRef: Boolean(record.staleRef),
      usedClipboard: Boolean(record.usedClipboard),
      movedFocus: Boolean(record.movedFocus),
      raw,
      message: firstString(record.message, undefined),
    };
  }

  async readClipboard(): Promise<{ ok: boolean; text?: string; raw?: unknown }> {
    const action = await this.runActionJson(["clipboard-get"]);
    const raw = action.raw;
    const record = asRecord(raw);
    const data = asRecord(record.data);
    return {
      ok: action.ok && record.ok !== false,
      text: firstString(data.text ?? data.value ?? record.text ?? record.value, undefined),
      raw,
    };
  }

  async writeClipboard(text: string): Promise<ActionResult> {
    const action = await this.runActionJson(["clipboard-set", text]);
    const raw = action.raw;
    const record = asRecord(raw);
    return {
      ok: action.ok && record.ok !== false,
      usedClipboard: true,
      raw,
      message: firstString(record.message, undefined),
    };
  }
}
