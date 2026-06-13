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

type OpenComputerUseRuntimeOptions = {
  command?: string;
  baseArgs?: string[];
  timeoutMs?: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(value: unknown): string;
function firstString(value: unknown, fallback: string): string;
function firstString(value: unknown, fallback: undefined): string | undefined;
function firstString(value: unknown, fallback: string | undefined): string | undefined;
function firstString(value: unknown, fallback = ""): string | undefined {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function firstNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstStringLike(value: unknown, fallback: string | undefined): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  }
  return typeof value === "string" && value.trim()
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
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

function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function readMcpText(raw: unknown): string | undefined {
  const top = asRecord(raw);
  const content = Array.isArray(top.content) ? top.content : [];
  const textParts = content
    .map((part) => firstString(asRecord(part).text, undefined))
    .filter((part): part is string => Boolean(part));
  return textParts.length ? textParts.join("\n") : firstString(top.text, undefined);
}

function unwrapPayload(raw: unknown): unknown {
  const top = asRecord(raw);
  const structured = top.structuredContent ?? top.structured_content;
  if (structured !== undefined) {
    return structured;
  }
  for (const key of ["data", "result", "output", "payload"]) {
    if (top[key] !== undefined) {
      return top[key];
    }
  }
  const text = readMcpText(raw);
  const parsedText = text ? tryParseJson(text) : undefined;
  return parsedText ?? raw;
}

function readArrayPayload(raw: unknown, key: string): unknown[] {
  const payload = unwrapPayload(raw);
  const top = asRecord(payload);
  const data = asRecord(top.data);
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(top[key])) {
    return top[key];
  }
  if (Array.isArray(data[key])) {
    return data[key];
  }
  return [];
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function readBounds(value: unknown): ElementRef["bounds"] {
  const record = asRecord(value);
  const x = firstNumber(record.x ?? record.left);
  const y = firstNumber(record.y ?? record.top);
  const width = firstNumber(record.width ?? record.w);
  const height = firstNumber(record.height ?? record.h);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    if (x === undefined || y === undefined) {
      return undefined;
    }
    const right = firstNumber(record.right);
    const bottom = firstNumber(record.bottom);
    return right === undefined || bottom === undefined
      ? undefined
      : { x, y, width: right - x, height: bottom - y };
  }
  return { x, y, width, height };
}

function parseAppTextLines(text: string | undefined): AppState[] {
  if (!text) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): AppState => {
      const match = /^(?<name>.+?)\s+[—-]\s+(?<bundle>[^\s[]+)(?:\s+\[(?<meta>.*)\])?$/.exec(line);
      const appName = firstString(match?.groups?.name, line);
      const meta = match?.groups?.meta ?? "";
      return {
        appName,
        frontmost: /\bfrontmost\b/i.test(meta),
      };
    });
}

function parseAppTextWindows(text: string | undefined): WindowState[] {
  // OCU currently exposes app inventory but not real window inventory. These
  // placeholder entries preserve workspace/frontmost telemetry without
  // pretending we have a restorable window handle.
  return parseAppTextLines(text).map(
    (app): WindowState => ({
      appName: app.appName,
      pid: app.pid,
      focused: app.frontmost === true,
    }),
  );
}

export function parseOpenComputerUseWindows(raw: unknown): WindowState[] {
  const structuredWindows = readArrayPayload(raw, "windows");
  if (!structuredWindows.length) {
    return parseAppTextWindows(readMcpText(raw));
  }
  return structuredWindows.map((candidate: unknown): WindowState => {
    const window = asRecord(candidate);
    return {
      id: firstStringLike(
        window.id ?? window.window_id ?? window.windowId ?? window.handle,
        undefined,
      ),
      appName: firstString(
        window.appName ?? window.app_name ?? window.app ?? window.ownerName,
        "unknown",
      ),
      pid: firstNumber(window.pid ?? window.processId),
      title: firstString(window.title ?? window.name ?? window.windowTitle, undefined),
      focused: window.focused === true || window.is_focused === true || window.frontmost === true,
    };
  });
}

export function parseOpenComputerUseApps(appsRaw: unknown, windowsRaw?: unknown): AppState[] {
  const windows = parseOpenComputerUseWindows(windowsRaw ?? appsRaw);
  const structuredApps = readArrayPayload(appsRaw, "apps");
  const apps = structuredApps.length
    ? structuredApps.map((candidate: unknown): AppState => {
        const app = asRecord(candidate);
        const appName = firstString(
          app.appName ?? app.app_name ?? app.name ?? app.displayName ?? app.bundleName,
          "unknown",
        );
        const pid = firstNumber(app.pid ?? app.processId);
        return {
          appName,
          pid,
          frontmost: app.frontmost === true || app.focused === true,
          windows: windows.filter(
            (window) =>
              (pid !== undefined && window.pid === pid) ||
              normalizeText(window.appName) === normalizeText(appName),
          ),
        };
      })
    : parseAppTextLines(readMcpText(appsRaw));

  return apps.map((app) => ({
    ...app,
    windows:
      app.windows ??
      windows.filter((window) => normalizeText(window.appName) === normalizeText(app.appName)),
  }));
}

function readSnapshotRoots(raw: unknown): unknown[] {
  const payload = unwrapPayload(raw);
  const record = asRecord(payload);
  const explicitRoots = [
    record.accessibilityTree,
    record.accessibility_tree,
    record.axTree,
    record.ax_tree,
    record.tree,
    record.root,
    record.elements,
    record.nodes,
  ].filter((root) => root !== undefined);
  return explicitRoots.length ? explicitRoots : [payload];
}

function readFrameFromText(line: string): ElementRef["bounds"] {
  const match =
    /Frame:\s*x=(?<x>-?\d+(?:\.\d+)?),\s*y=(?<y>-?\d+(?:\.\d+)?),\s*w=(?<w>\d+(?:\.\d+)?),\s*h=(?<h>\d+(?:\.\d+)?)/.exec(
      line,
    );
  if (!match?.groups) {
    return undefined;
  }
  const x = firstNumber(match.groups.x);
  const y = firstNumber(match.groups.y);
  const width = firstNumber(match.groups.w);
  const height = firstNumber(match.groups.h);
  return x === undefined || y === undefined || width === undefined || height === undefined
    ? undefined
    : { x, y, width, height };
}

function stripTextMetadata(line: string): string {
  const metadataIndex = [" ID:", " Value:", " Description:", " Secondary Actions:", " Frame:"]
    .map((marker) => line.indexOf(marker))
    .filter((index) => index >= 0)
    .toSorted((a, b) => a - b)[0];
  return (metadataIndex === undefined ? line : line.slice(0, metadataIndex)).trim();
}

function readTextMetadata(
  line: string,
  key: "Value" | "Description" | "Secondary Actions",
): string | undefined {
  const match = new RegExp(
    `${key}:\\s*(?<value>.*?)(?:\\s+(?:ID|Value|Description|Secondary Actions|Frame):|$)`,
  ).exec(line);
  return firstString(match?.groups?.value, undefined);
}

function parseSnapshotTextWindow(text: string | undefined): {
  appName?: string;
  windowTitle?: string;
  windowId?: string;
} {
  if (!text) {
    return {};
  }
  const appMatch = /^App=(?<rawApp>.+?)(?:\s+\(pid\s+(?<pid>\d+)\))?$/m.exec(text);
  const windowMatch = /^Window:\s+"(?<title>[^"]+)",\s+App:\s+(?<app>[^.]+)\./m.exec(text);
  const windowIdMatch = /^\s*0\s+.+?\s+ID:\s+(?<id>\S+)/m.exec(text);
  return {
    appName: firstString(windowMatch?.groups?.app ?? appMatch?.groups?.rawApp, undefined),
    windowTitle: firstString(windowMatch?.groups?.title, undefined),
    windowId: firstString(windowIdMatch?.groups?.id, undefined),
  };
}

function parseSnapshotTextElements(text: string | undefined, target: AppTarget): ElementRef[] {
  if (!text) {
    return [];
  }

  return text
    .split(/\r?\n/)
    .map((line): ElementRef | undefined => {
      const match = /^\s*(?<index>\d+)\s+(?<body>.+)$/.exec(line);
      if (!match?.groups) {
        return undefined;
      }

      const body = match.groups.body;
      const roleAndLabel = stripTextMetadata(body);
      return {
        // OCU action tools use the numeric element_index from the latest app
        // state. Prefix with @ so Jarvis refs stay distinct but reversible.
        ref: `@${match.groups.index}`,
        role: roleAndLabel,
        label: roleAndLabel,
        description: readTextMetadata(body, "Description"),
        value: readTextMetadata(body, "Value"),
        secondaryActions: stringList(readTextMetadata(body, "Secondary Actions")),
        bounds: readFrameFromText(body),
        appName: target.appName,
        windowTitle: target.windowTitle,
      };
    })
    .filter((element): element is ElementRef => Boolean(element));
}

function readElementRef(
  record: Record<string, unknown>,
  fallbackIndex: number,
): { ref: string; usedFallback: boolean } {
  const explicit = firstStringLike(
    record.ref ??
      record.ref_id ??
      record.elementRef ??
      record.element_ref ??
      record.id ??
      record.elementId ??
      record.element_id,
    undefined,
  );
  if (explicit) {
    return { ref: explicit, usedFallback: false };
  }
  const index = firstNumber(record.element_index ?? record.elementIndex ?? record.index);
  return index === undefined
    ? { ref: `@${fallbackIndex}`, usedFallback: true }
    : { ref: `@${index}`, usedFallback: false };
}

export function parseOpenComputerUseSnapshot(raw: unknown, target: AppTarget): GuiSnapshot {
  const payload = asRecord(unwrapPayload(raw));
  const windowRecord = asRecord(payload.window);
  const visibleText = new Set<string>();
  const elements: ElementRef[] = [];
  let fallbackIndex = 0;

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

    for (const key of ["text", "value", "label", "name", "title", "description"]) {
      const text = firstString(record[key], undefined);
      if (text) {
        visibleText.add(text);
      }
    }

    const role = firstString(
      record.role ?? record.axRole ?? record.ax_role ?? record.type,
      undefined,
    );
    const hasElementIdentity =
      role ||
      record.ref !== undefined ||
      record.ref_id !== undefined ||
      record.element_index !== undefined ||
      record.elementIndex !== undefined ||
      record.index !== undefined;
    if (hasElementIdentity) {
      const name = firstString(record.name ?? record.title, undefined);
      const description = firstString(record.description ?? record.help, undefined);
      const elementRef = readElementRef(record, fallbackIndex);
      if (elementRef.usedFallback) {
        fallbackIndex += 1;
      }
      elements.push({
        ref: elementRef.ref,
        role,
        name,
        title: firstString(record.title, undefined),
        label: firstString(record.label ?? name ?? description, undefined),
        description,
        value: firstString(record.value ?? record.text, undefined),
        bounds: readBounds(record.bounds ?? record.frame ?? record.rect),
        secondaryActions: stringList(
          record.secondaryActions ??
            record.secondary_actions ??
            record.actions ??
            record.axActions ??
            record.ax_actions,
        ),
        appName: target.appName,
        windowTitle: target.windowTitle,
      });
    }

    // OCU has already changed between MCP envelopes and AX-tree names. Visit
    // the common child containers instead of binding to one exact schema.
    for (const childKey of ["children", "elements", "nodes", "items", "tree"]) {
      visit(record[childKey]);
    }
  }

  for (const root of readSnapshotRoots(raw)) {
    visit(root);
  }

  const text = readMcpText(raw);
  const textWindow = parseSnapshotTextWindow(text);
  const textElements = parseSnapshotTextElements(text, {
    ...target,
    windowTitle: textWindow.windowTitle ?? target.windowTitle,
  });
  for (const element of textElements) {
    elements.push(element);
    for (const textPart of [element.label, element.description, element.value]) {
      if (textPart) {
        visibleText.add(textPart);
      }
    }
  }

  const snapshotId = firstString(
    payload.snapshotId ?? payload.snapshot_id ?? payload.id,
    `open-computer-use-${Date.now()}`,
  );
  return {
    id: snapshotId,
    appName: firstString(
      payload.appName ?? payload.app ?? textWindow.appName ?? target.appName,
      target.appName,
    ),
    windowId: firstStringLike(
      windowRecord.id ??
        windowRecord.window_id ??
        windowRecord.windowId ??
        textWindow.windowId ??
        target.windowId,
      target.windowId,
    ),
    windowTitle: firstString(
      payload.windowTitle ??
        payload.window_title ??
        windowRecord.title ??
        textWindow.windowTitle ??
        target.windowTitle,
      target.windowTitle,
    ),
    summary: firstString(payload.summary ?? text, undefined),
    visibleText: Array.from(visibleText).slice(0, 500),
    raw,
    elements,
  };
}

export function parseOpenComputerUseActionResult(raw: unknown, commandOk = true): ActionResult {
  const record = asRecord(raw);
  const payload = asRecord(unwrapPayload(raw));
  const isError = record.isError === true || payload.isError === true;
  const message = firstString(
    payload.message ?? payload.error ?? record.message ?? record.error ?? readMcpText(raw),
    undefined,
  );
  return {
    ok:
      commandOk &&
      !isError &&
      record.ok !== false &&
      payload.ok !== false &&
      payload.success !== false,
    actionCount: firstNumber(payload.actionCount ?? payload.action_count) ?? 1,
    staleRef: /stale|element.*not.*found|invalid.*element/i.test(message ?? ""),
    // OCU element-index actions should not touch clipboard or raw coordinates.
    // Preserve explicit telemetry if a future CLI starts returning it.
    usedClipboard: Boolean(payload.usedClipboard ?? payload.used_clipboard ?? record.usedClipboard),
    rawCoordinatesUsed: Boolean(
      payload.rawCoordinatesUsed ?? payload.raw_coordinates_used ?? record.rawCoordinatesUsed,
    ),
    movedFocus: Boolean(payload.movedFocus ?? payload.moved_focus ?? record.movedFocus),
    message,
    raw,
  };
}

function readElementIndex(target: ElementRef): number | undefined {
  const fromRef = /^@?(\d+)$/.exec(target.ref) ?? /^ocu:(\d+)$/.exec(target.ref);
  return firstNumber(fromRef?.[1]);
}

function elementArgs(target: ElementRef): Record<string, unknown> {
  const elementIndex = readElementIndex(target);
  return {
    app: target.appName,
    ...(target.windowTitle ? { window: target.windowTitle } : {}),
    ...(elementIndex !== undefined ? { element_index: elementIndex } : { element_ref: target.ref }),
  };
}

export class OpenComputerUseRuntime implements GuiRuntime {
  readonly name = "open-computer-use" as const;
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly timeoutMs: number;

  constructor(options: OpenComputerUseRuntimeOptions = {}) {
    this.command = options.command ?? "open-computer-use";
    this.baseArgs = options.baseArgs ?? [];
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

  private async callTool(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.runJson(["call", tool, "--args", JSON.stringify(args)]);
  }

  private async callAction(
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<ActionResult> {
    const result = await this.runActionJson(["call", tool, "--args", JSON.stringify(args)]);
    return parseOpenComputerUseActionResult(result.raw, result.ok);
  }

  async listApps(): Promise<AppState[]> {
    return parseOpenComputerUseApps(await this.callTool("list_apps"));
  }

  async listWindows(): Promise<WindowState[]> {
    return parseOpenComputerUseWindows(await this.callTool("list_apps"));
  }

  async focusWindow(target: WindowState): Promise<ActionResult> {
    return {
      ok: false,
      actionCount: 0,
      movedFocus: false,
      usedClipboard: false,
      rawCoordinatesUsed: false,
      message:
        "OpenComputerUse CLI does not expose a supported window or app focus tool for workspace restore.",
      raw: {
        unsupported: "focusWindow",
        target,
      },
    };
  }

  async observe(target: AppTarget): Promise<GuiSnapshot> {
    return parseOpenComputerUseSnapshot(
      await this.callTool("get_app_state", { app: target.appName }),
      target,
    );
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

  async setValue(target: ElementRef, value: string): Promise<ActionResult> {
    return this.callAction("set_value", { ...elementArgs(target), value });
  }

  async click(target: ElementRef): Promise<ActionResult> {
    return this.callAction("click", elementArgs(target));
  }

  async performSecondaryAction(target: ElementRef, action: string): Promise<ActionResult> {
    return this.callAction("perform_secondary_action", { ...elementArgs(target), action });
  }

  async press(target: AppTarget, keys: string[]): Promise<ActionResult> {
    return this.callAction("press_key", { app: target.appName, key: keys.join("+") });
  }

  async scroll(
    target: ElementRef,
    options: { direction?: "up" | "down" | "left" | "right"; amount?: number } = {},
  ): Promise<ActionResult> {
    return this.callAction("scroll", {
      ...elementArgs(target),
      direction: options.direction ?? "down",
      pages: options.amount ?? 3,
    });
  }
}
