import { clickAriaRefViaCdp } from "../cdp.js";
import {
  clickChromeMcpElement,
  closeChromeMcpTab,
  dragChromeMcpElement,
  evaluateChromeMcpScript,
  fillChromeMcpElement,
  fillChromeMcpForm,
  hoverChromeMcpElement,
  pressChromeMcpKey,
  resizeChromeMcpPage,
  takeChromeMcpSnapshot,
} from "../chrome-mcp.js";
import type { BrowserActRequest, BrowserFormField } from "../client-actions-core.js";
import { normalizeBrowserFormField } from "../form-fields.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import { isPlaywrightCdpAttachTimeout } from "../pw-session.js";
import type { BrowserRouteContext } from "../server-context.js";
import { matchBrowserUrlPattern } from "../url-pattern.js";
import { registerBrowserAgentActDownloadRoutes } from "./agent.act.download.js";
import { registerBrowserAgentActHookRoutes } from "./agent.act.hooks.js";
import {
  type ActKind,
  isActKind,
  parseClickButton,
  parseClickModifiers,
} from "./agent.act.shared.js";
import {
  readBody,
  requirePwAi,
  resolveTargetIdFromBody,
  withRouteTabContext,
  SELECTOR_UNSUPPORTED_MESSAGE,
} from "./agent.shared.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, toBoolean, toNumber, toStringArray, toStringOrEmpty } from "./utils.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canFallbackClickViaCdp(params: {
  ref?: string;
  selector?: string;
  wsUrl?: string;
}): boolean {
  const ref = params.ref?.trim() ?? "";
  return Boolean(params.wsUrl) && !params.selector && /^@?ax\d+$/.test(ref);
}

function isExistingSessionMissingUidError(err: unknown, uid: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(`Element uid "${uid}" not found`);
}

function looksLikeHumanTextRef(ref: string): boolean {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.length > 80) {
    return false;
  }
  if (/^@?ax\d+$/i.test(trimmed) || /^[a-z][a-z0-9]*-\d+$/i.test(trimmed)) {
    return false;
  }
  return /[A-Za-z]/.test(trimmed) && !/[.[\]#>:=]/.test(trimmed);
}

async function clickExistingSessionTextRef(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  text: string;
  timeoutMs?: number;
}): Promise<void> {
  await evaluateChromeMcpScript({
    profileName: params.profileName,
    userDataDir: params.userDataDir,
    targetId: params.targetId,
    fn: `() => {
      const wanted = ${JSON.stringify(params.text)}.replace(/\\s+/g, " ").trim();

      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const clickableFor = (el) =>
        el.closest('button, a, [role="button"], [role="option"], [role="menuitem"], [role="tab"], .ant-select-item-option, .ant-select-item, [data-option-index]') || el;
      const candidates = Array.from(document.querySelectorAll("body *"))
        .filter(visible)
        .map((el) => {
          const text = normalize(el.textContent);
          const aria = normalize(el.getAttribute("aria-label"));
          const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? normalize(el.value) : "";
          return { el, text, aria, value };
        })
        .filter(({ text, aria, value }) => text === wanted || aria === wanted || value === wanted);

      if (candidates.length === 0) {
        throw new Error(\`No visible text ref matches: \${wanted}\`);
      }

      const ranked = candidates
        .map(({ el }) => clickableFor(el))
        .filter((el, index, all) => all.indexOf(el) === index)
        .sort((a, b) => {
          const aRole = String(a.getAttribute("role") || "").toLowerCase();
          const bRole = String(b.getAttribute("role") || "").toLowerCase();
          const aScore = aRole === "option" || aRole === "button" || a.tagName === "BUTTON" ? 0 : 1;
          const bScore = bRole === "option" || bRole === "button" || b.tagName === "BUTTON" ? 0 : 1;
          if (aScore !== bScore) return aScore - bScore;
          return a.getBoundingClientRect().height - b.getBoundingClientRect().height;
        });

      const target = ranked[0];
      if (!(target instanceof HTMLElement)) {
        throw new Error(\`Visible text ref is not clickable: \${wanted}\`);
      }
      target.scrollIntoView({ block: "center", inline: "center" });
      target.click();
      return true;
    }`,
    timeoutMs: params.timeoutMs,
  });
}

function browserEvaluateDisabledMessage(action: "wait" | "evaluate"): string {
  return [
    action === "wait"
      ? "wait --fn is disabled by config (browser.evaluateEnabled=false)."
      : "act:evaluate is disabled by config (browser.evaluateEnabled=false).",
    "Docs: /gateway/configuration#browser-openclaw-managed-browser",
  ].join("\n");
}

function readActRef(body: Record<string, unknown>): string | undefined {
  const ref = toStringOrEmpty(body.ref) || toStringOrEmpty(body.inputRef);
  return ref || undefined;
}

function readActSelector(body: Record<string, unknown>): string | undefined {
  const selector = toStringOrEmpty(body.selector);
  if (selector) {
    return selector;
  }
  // Some tool callers still send screenshot-style `element` for act targets.
  // Treat it as a selector fallback so valid legacy flattened calls do not die
  // before the existing-session selector fallback gets a chance to run.
  const element = toStringOrEmpty(body.element);
  return element || undefined;
}

function isRetryableChromeMcpElementSnapshotError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /Element uid ".+" not found/i.test(message) || /No snapshot found for page \d+/i.test(message)
  );
}

function buildExistingSessionStaleRefGuidance(params: {
  kind: ActKind;
  profileName: string;
  targetId: string;
  cause: unknown;
}): Error {
  const causeMessage = params.cause instanceof Error ? params.cause.message : String(params.cause);
  return new Error(
    [
      `existing-session ${params.kind} target is stale or the Chrome MCP snapshot cache is missing.`,
      `Run browser action=snapshot profile="${params.profileName}" targetId="${params.targetId}", then retry with a fresh ref from that snapshot.`,
      `Last Chrome MCP error: ${causeMessage}`,
    ].join(" "),
    { cause: params.cause },
  );
}

function jsLiteral(value: string): string {
  return JSON.stringify(value);
}

function buildExistingSessionTypeSelectorScript(selector: string, value: string): string {
  return `() => {
    const selector = ${jsLiteral(selector)};
    const value = ${jsLiteral(value)};
    const el = document.querySelector(selector);
    if (!(el instanceof HTMLElement)) {
      throw new Error(\`No element matches selector: \${selector}\`);
    }
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = value;
    } else {
      el.setAttribute("value", value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }`;
}

function buildExistingSessionPasteScript(params: {
  selector?: string;
  value: string;
  clear: boolean;
}): string {
  return `(targetOrNull) => {
    const selector = ${jsLiteral(params.selector ?? "")};
    const value = ${jsLiteral(params.value)};
    const shouldClear = ${params.clear ? "true" : "false"};
    const editableSelector = 'input:not([type="hidden"]), textarea, [contenteditable="true"], [role="textbox"]';
    const resolveTarget = () => {
      if (selector) {
        return document.querySelector(selector);
      }
      if (targetOrNull instanceof Element) {
        return targetOrNull;
      }
      return document.activeElement;
    };
    const dispatchInputEvents = (el, inputType) => {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const replaceInputValue = (el, nextValue) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      descriptor && descriptor.set ? descriptor.set.call(el, nextValue) : (el.value = nextValue);
    };

    let target = resolveTarget();
    if (!(target instanceof HTMLElement)) {
      throw new Error(selector ? \`No element matches selector: \${selector}\` : "paste target was not found");
    }
    if (!target.matches(editableSelector)) {
      const nested = target.querySelector(editableSelector);
      if (nested instanceof HTMLElement) {
        target = nested;
      }
    }
    target.scrollIntoView({ block: "center", inline: "center" });
    target.focus();

    if (shouldClear) {
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        replaceInputValue(target, "");
        dispatchInputEvents(target, "deleteContentBackward");
      } else if (target.isContentEditable || target.getAttribute("role") === "textbox") {
        target.textContent = "";
        dispatchInputEvents(target, "deleteContentBackward");
      }
    }

    const data = new DataTransfer();
    data.setData("text/plain", value);
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    const consumedPaste = !target.dispatchEvent(pasteEvent);
    if (consumedPaste) {
      return true;
    }

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      const nextValue = target.value.slice(0, start) + value + target.value.slice(end);
      replaceInputValue(target, nextValue);
      const caret = start + value.length;
      target.setSelectionRange(caret, caret);
      dispatchInputEvents(target, "insertFromPaste");
      return true;
    }

    if (target.isContentEditable || target.getAttribute("role") === "textbox") {
      if (!document.execCommand("insertText", false, value)) {
        target.textContent = String(target.textContent || "") + value;
      }
      dispatchInputEvents(target, "insertFromPaste");
      return true;
    }

    throw new Error("paste target is not editable");
  }`;
}

function buildExistingSessionClickSelectorScript(selector: string): string {
  return `() => {
    const selector = ${jsLiteral(selector)};
    const el = document.querySelector(selector);
    if (!(el instanceof HTMLElement)) {
      throw new Error(\`No element matches selector: \${selector}\`);
    }
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    return true;
  }`;
}

function buildExistingSessionFillSelectorScript(selector: string, value: string): string {
  return `() => {
    const selector = ${jsLiteral(selector)};
    const value = ${jsLiteral(value)};
    const el = document.querySelector(selector);
    if (!(el instanceof HTMLElement)) {
      throw new Error(\`No element matches selector: \${selector}\`);
    }
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") {
        el.checked = value === "true" || value === "1";
      } else {
        el.value = value;
      }
    } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      el.value = value;
    } else {
      el.setAttribute("value", value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }`;
}

async function refreshExistingSessionSnapshot(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
}): Promise<void> {
  await takeChromeMcpSnapshot(params);
}

async function runExistingSessionElementActionWithSnapshotRetry(params: {
  kind: ActKind;
  profileName: string;
  userDataDir?: string;
  targetId: string;
  run: () => Promise<void>;
}): Promise<void> {
  try {
    await params.run();
    return;
  } catch (err) {
    if (!isRetryableChromeMcpElementSnapshotError(err)) {
      throw err;
    }
    try {
      await refreshExistingSessionSnapshot({
        profileName: params.profileName,
        userDataDir: params.userDataDir,
        targetId: params.targetId,
      });
      await params.run();
      return;
    } catch (retryErr) {
      throw buildExistingSessionStaleRefGuidance({
        kind: params.kind,
        profileName: params.profileName,
        targetId: params.targetId,
        cause: retryErr,
      });
    }
  }
}

function buildExistingSessionWaitPredicate(params: {
  text?: string;
  textGone?: string;
  selector?: string;
  loadState?: "load" | "domcontentloaded" | "networkidle";
  fn?: string;
}): string | null {
  const checks: string[] = [];
  if (params.text) {
    checks.push(`Boolean(document.body?.innerText?.includes(${JSON.stringify(params.text)}))`);
  }
  if (params.textGone) {
    checks.push(`!document.body?.innerText?.includes(${JSON.stringify(params.textGone)})`);
  }
  if (params.selector) {
    checks.push(`Boolean(document.querySelector(${JSON.stringify(params.selector)}))`);
  }
  if (params.loadState === "domcontentloaded") {
    checks.push(`document.readyState === "interactive" || document.readyState === "complete"`);
  } else if (params.loadState === "load" || params.loadState === "networkidle") {
    // Chrome DevTools MCP does not expose Playwright's networkidle signal for
    // existing-session. Degrade to the strongest universally available browser
    // readiness check instead of hard-failing a recoverable wait.
    checks.push(`document.readyState === "complete"`);
  }
  if (params.fn) {
    checks.push(`Boolean(await (${params.fn})())`);
  }
  if (checks.length === 0) {
    return null;
  }
  return checks.length === 1 ? checks[0] : checks.map((check) => `(${check})`).join(" && ");
}

async function focusExistingSessionPressTarget(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  ref?: string;
  selector?: string;
  timeoutMs?: number;
}): Promise<void> {
  if (params.ref) {
    // Chrome MCP only exposes key presses against the focused page, not a
    // target uid. A ref click is the smallest reliable way to put focus where
    // the model intended before sending the key.
    await clickChromeMcpElement({
      profileName: params.profileName,
      userDataDir: params.userDataDir,
      targetId: params.targetId,
      uid: params.ref,
      timeoutMs: params.timeoutMs,
    });
    return;
  }

  if (!params.selector) {
    return;
  }

  await evaluateChromeMcpScript({
    profileName: params.profileName,
    userDataDir: params.userDataDir,
    targetId: params.targetId,
    fn: `(selector) => {
      const el = document.querySelector(selector);
      if (!(el instanceof HTMLElement)) {
        throw new Error(\`No element matches selector: \${selector}\`);
      }

      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus({ preventScroll: true });

      const role = String(el.getAttribute("role") || "").toLowerCase();
      const className = String(el.className || "");
      const needsPointerFocus =
        document.activeElement !== el &&
        (role === "combobox" ||
          role === "listbox" ||
          role === "textbox" ||
          /\\b(ant-select|rc-select|select2)\\b/i.test(className));

      // Custom combobox wrappers often ignore HTMLElement.focus(); one click
      // opens/focuses them so the following press_key lands on the intended UI.
      if (needsPointerFocus) {
        el.click();
      }

      return true;
    }`,
    args: [params.selector],
    timeoutMs: params.timeoutMs,
  });
}

async function waitForExistingSessionCondition(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  timeMs?: number;
  text?: string;
  textGone?: string;
  selector?: string;
  url?: string;
  loadState?: "load" | "domcontentloaded" | "networkidle";
  fn?: string;
  timeoutMs?: number;
}): Promise<void> {
  if (params.timeMs && params.timeMs > 0) {
    await sleep(params.timeMs);
  }
  const predicate = buildExistingSessionWaitPredicate(params);
  if (!predicate && !params.url) {
    return;
  }
  const timeoutMs = Math.max(250, params.timeoutMs ?? 10_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let ready = true;
    if (predicate) {
      ready = Boolean(
        await evaluateChromeMcpScript({
          profileName: params.profileName,
          userDataDir: params.userDataDir,
          targetId: params.targetId,
          fn: `async () => ${predicate}`,
        }),
      );
    }
    if (ready && params.url) {
      const currentUrl = await evaluateChromeMcpScript({
        profileName: params.profileName,
        userDataDir: params.userDataDir,
        targetId: params.targetId,
        fn: "() => window.location.href",
      });
      ready = typeof currentUrl === "string" && matchBrowserUrlPattern(params.url, currentUrl);
    }
    if (ready) {
      return;
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for condition");
}

function buildExistingSessionChooseOptionScript(params: {
  target: "ref" | "selector";
  selector?: string;
  optionText: string;
  matchMode: "exact" | "contains" | "regex";
  queryText: string;
  timeoutMs: number;
}): string {
  const targetExpression =
    params.target === "selector"
      ? `document.querySelector(${jsLiteral(params.selector ?? "")})`
      : `targetOrControl`;
  return `(targetOrControl) => new Promise((resolve, reject) => {
    const control = ${targetExpression};
    if (!(control instanceof Element)) {
      reject(new Error("chooseOption target was not found"));
      return;
    }

    const optionText = ${jsLiteral(params.optionText)}.replace(/\\s+/g, " ").trim();
    const matchMode = ${jsLiteral(params.matchMode)};
    const queryText = ${jsLiteral(params.queryText)}.replace(/\\s+/g, " ").trim();
    const timeoutMs = ${params.timeoutMs};
    const optionSelector = [
      '[role="option"]',
      '[role="treeitem"]',
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option',
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item',
      '.rc-select-dropdown .rc-select-item-option',
      '.select2-results__option',
      '[data-option-index]'
    ].join(", ");
    const editableSelector = 'input:not([type="hidden"]), textarea, [contenteditable="true"], [role="textbox"]';
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const disabled = (el) => {
      const className = String(el.className || "");
      return el.getAttribute("aria-disabled") === "true" || el.hasAttribute("disabled") || /\\b(disabled|ant-select-item-option-disabled)\\b/i.test(className);
    };
    const matches = (text) => {
      const actual = normalize(text);
      if (!optionText) return false;
      if (matchMode === "exact") return actual === optionText || actual.toLowerCase() === optionText.toLowerCase();
      if (matchMode === "contains") return actual.toLowerCase().includes(optionText.toLowerCase());
      try {
        return new RegExp(optionText, "i").test(actual);
      } catch {
        return false;
      }
    };
    const setValue = (el, value) => {
      el.focus();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        descriptor && descriptor.set ? descriptor.set.call(el, value) : (el.value = value);
      } else if (el instanceof HTMLElement) {
        el.textContent = value;
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const clickElement = (el) => {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.click();
    };
    const controlRoot = visible(control)
      ? control
      : control.parentElement?.closest('.ant-select, .ant-select-selector, .ant-select-content, [role="combobox"]') || control;
    const beforeText = normalize(controlRoot.textContent);
    controlRoot.scrollIntoView({ block: "center", inline: "center" });
    clickElement(controlRoot);
    const editable =
      controlRoot.querySelector(editableSelector) ||
      (control.matches(editableSelector) ? control : null) ||
      document.activeElement;
    if (editable instanceof Element && editable.matches(editableSelector)) {
      setValue(editable, queryText);
    }

    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const options = Array.from(document.querySelectorAll(optionSelector))
        .filter((el) => visible(el) && !disabled(el));
      const option = options.find((el) => matches(el.textContent || ""));
      if (option) {
        const matchedText = normalize(option.textContent);
        clickElement(option);
        setTimeout(() => {
          const selectedText = normalize(controlRoot.textContent);
          resolve({
            optionText,
            matchedText,
            selectedText,
            changed: beforeText && selectedText ? beforeText !== selectedText : undefined
          });
        }, 150);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('No visible option matched "' + optionText + '"'));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  })`;
}

function normalizeChooseOptionText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function matchesChooseOptionText(params: {
  matchedText: string;
  optionText: string;
  matchMode: "exact" | "contains" | "regex";
}): boolean {
  const matchedText = normalizeChooseOptionText(params.matchedText);
  const optionText = normalizeChooseOptionText(params.optionText);
  if (!optionText) {
    return false;
  }
  if (params.matchMode === "exact") {
    return matchedText === optionText || matchedText.toLowerCase() === optionText.toLowerCase();
  }
  if (params.matchMode === "contains") {
    return matchedText.toLowerCase().includes(optionText.toLowerCase());
  }
  try {
    return new RegExp(optionText, "i").test(matchedText);
  } catch {
    return false;
  }
}

function validateExistingSessionChooseOptionResult(params: {
  result: unknown;
  optionText: string;
  matchMode: "exact" | "contains" | "regex";
}): string | null {
  if (!params.result || typeof params.result !== "object" || Array.isArray(params.result)) {
    return "chooseOption did not return a structured result with matchedText";
  }
  const matchedText = (params.result as { matchedText?: unknown }).matchedText;
  if (typeof matchedText !== "string" || !matchedText.trim()) {
    return "chooseOption did not return matchedText, so the selected option cannot be verified";
  }
  if (
    !matchesChooseOptionText({
      matchedText,
      optionText: params.optionText,
      matchMode: params.matchMode,
    })
  ) {
    return `chooseOption matched "${normalizeChooseOptionText(matchedText)}", but optionText was "${normalizeChooseOptionText(
      params.optionText,
    )}"`;
  }
  return null;
}

const SELECTOR_ALLOWED_KINDS: ReadonlySet<string> = new Set([
  "batch",
  "click",
  "chooseOption",
  "drag",
  "hover",
  "press",
  "scrollIntoView",
  "select",
  "type",
  "wait",
]);
const MAX_BATCH_ACTIONS = 100;
const MAX_BATCH_CLICK_DELAY_MS = 5_000;
const MAX_BATCH_WAIT_TIME_MS = 30_000;

function parseChooseOptionMatchMode(value: unknown): "exact" | "contains" | "regex" | undefined {
  const match = toStringOrEmpty(value);
  return match === "contains" || match === "regex" || match === "exact" ? match : undefined;
}

function normalizeBoundedNonNegativeMs(
  value: unknown,
  fieldName: string,
  maxMs: number,
): number | undefined {
  const ms = toNumber(value);
  if (ms === undefined) {
    return undefined;
  }
  if (ms < 0) {
    throw new Error(`${fieldName} must be >= 0`);
  }
  const normalized = Math.floor(ms);
  if (normalized > maxMs) {
    throw new Error(`${fieldName} exceeds maximum of ${maxMs}ms`);
  }
  return normalized;
}

function countBatchActions(actions: BrowserActRequest[]): number {
  let count = 0;
  for (const action of actions) {
    count += 1;
    if (action.kind === "batch") {
      count += countBatchActions(action.actions);
    }
  }
  return count;
}

function validateBatchTargetIds(actions: BrowserActRequest[], targetId: string): string | null {
  for (const action of actions) {
    if (action.targetId && action.targetId !== targetId) {
      return "batched action targetId must match request targetId";
    }
    if (action.kind === "batch") {
      const nestedError = validateBatchTargetIds(action.actions, targetId);
      if (nestedError) {
        return nestedError;
      }
    }
  }
  return null;
}

function normalizeBatchAction(value: unknown): BrowserActRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("batch actions must be objects");
  }
  const raw = value as Record<string, unknown>;
  const kind = toStringOrEmpty(raw.kind);
  if (!isActKind(kind)) {
    throw new Error("batch actions must use a supported kind");
  }

  switch (kind) {
    case "click": {
      const ref = toStringOrEmpty(raw.ref) || undefined;
      const selector = toStringOrEmpty(raw.selector) || undefined;
      if (!ref && !selector) {
        throw new Error("click requires ref or selector");
      }
      const buttonRaw = toStringOrEmpty(raw.button);
      const button = buttonRaw ? parseClickButton(buttonRaw) : undefined;
      if (buttonRaw && !button) {
        throw new Error("click button must be left|right|middle");
      }
      const modifiersRaw = toStringArray(raw.modifiers) ?? [];
      const parsedModifiers = parseClickModifiers(modifiersRaw);
      if (parsedModifiers.error) {
        throw new Error(parsedModifiers.error);
      }
      const doubleClick = toBoolean(raw.doubleClick);
      const delayMs = normalizeBoundedNonNegativeMs(
        raw.delayMs,
        "click delayMs",
        MAX_BATCH_CLICK_DELAY_MS,
      );
      const timeoutMs = toNumber(raw.timeoutMs);
      const targetId = toStringOrEmpty(raw.targetId) || undefined;
      return {
        kind,
        ...(ref ? { ref } : {}),
        ...(selector ? { selector } : {}),
        ...(targetId ? { targetId } : {}),
        ...(doubleClick !== undefined ? { doubleClick } : {}),
        ...(button ? { button } : {}),
        ...(parsedModifiers.modifiers ? { modifiers: parsedModifiers.modifiers } : {}),
        ...(delayMs !== undefined ? { delayMs } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "type":
    case "paste": {
      const ref = toStringOrEmpty(raw.ref) || undefined;
      const selector = toStringOrEmpty(raw.selector) || undefined;
      const text = raw.text;
      if (!ref && !selector) {
        throw new Error(`${kind} requires ref or selector`);
      }
      if (typeof text !== "string") {
        throw new Error(`${kind} requires text`);
      }
      const targetId = toStringOrEmpty(raw.targetId) || undefined;
      const submit = toBoolean(raw.submit);
      const slowly = toBoolean(raw.slowly);
      const clear = toBoolean(raw.clear);
      const timeoutMs = toNumber(raw.timeoutMs);
      const base = {
        kind,
        ...(ref ? { ref } : {}),
        ...(selector ? { selector } : {}),
        text,
        ...(targetId ? { targetId } : {}),
        ...(submit !== undefined ? { submit } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
      if (kind === "paste") {
        return {
          ...base,
          ...(clear !== undefined ? { clear } : {}),
        };
      }
      return {
        ...base,
        ...(slowly !== undefined ? { slowly } : {}),
      };
    }
    case "press": {
      const key = toStringOrEmpty(raw.key);
      if (!key) {
        throw new Error("press requires key");
      }
      const ref = toStringOrEmpty(raw.ref) || undefined;
      const selector = toStringOrEmpty(raw.selector) || undefined;
      const targetId = toStringOrEmpty(raw.targetId) || undefined;
      const delayMs = toNumber(raw.delayMs);
      const timeoutMs = toNumber(raw.timeoutMs);
      return {
        kind,
        key,
        ...(ref ? { ref } : {}),
        ...(selector ? { selector } : {}),
        ...(targetId ? { targetId } : {}),
        ...(delayMs !== undefined ? { delayMs } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "hover":
    case "scrollIntoView": {
      const ref = toStringOrEmpty(raw.ref) || undefined;
      const selector = toStringOrEmpty(raw.selector) || undefined;
      if (!ref && !selector) {
        throw new Error(`${kind} requires ref or selector`);
      }
      const targetId = toStringOrEmpty(raw.targetId) || undefined;
      const timeoutMs = toNumber(raw.timeoutMs);
      return {
        kind,
        ...(ref ? { ref } : {}),
        ...(selector ? { selector } : {}),
        ...(targetId ? { targetId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "drag": {
      const startRef = toStringOrEmpty(raw.startRef) || undefined;
      const startSelector = toStringOrEmpty(raw.startSelector) || undefined;
      const endRef = toStringOrEmpty(raw.endRef) || undefined;
      const endSelector = toStringOrEmpty(raw.endSelector) || undefined;
      if (!startRef && !startSelector) {
        throw new Error("drag requires startRef or startSelector");
      }
      if (!endRef && !endSelector) {
        throw new Error("drag requires endRef or endSelector");
      }
      const targetId = toStringOrEmpty(raw.targetId) || undefined;
      const timeoutMs = toNumber(raw.timeoutMs);
      return {
        kind,
        ...(startRef ? { startRef } : {}),
        ...(startSelector ? { startSelector } : {}),
        ...(endRef ? { endRef } : {}),
        ...(endSelector ? { endSelector } : {}),
        ...(targetId ? { targetId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "select": {
      const ref = toStringOrEmpty(raw.ref) || undefined;
      const selector = toStringOrEmpty(raw.selector) || undefined;
      const values = toStringArray(raw.values);
      if ((!ref && !selector) || !values?.length) {
        throw new Error("select requires ref/selector and values");
      }
      const targetId = toStringOrEmpty(raw.targetId) || undefined;
      const timeoutMs = toNumber(raw.timeoutMs);
      return {
        kind,
        ...(ref ? { ref } : {}),
        ...(selector ? { selector } : {}),
        values,
        ...(targetId ? { targetId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "chooseOption": {
      const ref = toStringOrEmpty(raw.ref) || undefined;
      const selector = toStringOrEmpty(raw.selector) || undefined;
      const optionText = toStringOrEmpty(raw.optionText);
      if ((!ref && !selector) || !optionText) {
        throw new Error("chooseOption requires ref/selector and optionText");
      }
      const query = toStringOrEmpty(raw.query) || undefined;
      const match = parseChooseOptionMatchMode(raw.match);
      const targetId = toStringOrEmpty(raw.targetId) || undefined;
      const timeoutMs = toNumber(raw.timeoutMs);
      return {
        kind,
        ...(ref ? { ref } : {}),
        ...(selector ? { selector } : {}),
        optionText,
        ...(query ? { query } : {}),
        ...(match ? { match } : {}),
        ...(targetId ? { targetId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "fill": {
      const rawFields = Array.isArray(raw.fields) ? raw.fields : [];
      const fields = rawFields
        .map((field) => {
          if (!field || typeof field !== "object") {
            return null;
          }
          return normalizeBrowserFormField(field as Record<string, unknown>);
        })
        .filter((field): field is BrowserFormField => field !== null);
      if (!fields.length) {
        throw new Error("fill requires fields");
      }
      const targetId = toStringOrEmpty(raw.targetId) || undefined;
      const timeoutMs = toNumber(raw.timeoutMs);
      return {
        kind,
        fields,
        ...(targetId ? { targetId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "resize": {
      const width = toNumber(raw.width);
      const height = toNumber(raw.height);
      if (width === undefined || height === undefined) {
        throw new Error("resize requires width and height");
      }
      const targetId = toStringOrEmpty(raw.targetId) || undefined;
      return {
        kind,
        width,
        height,
        ...(targetId ? { targetId } : {}),
      };
    }
    case "wait": {
      const loadStateRaw = toStringOrEmpty(raw.loadState);
      const loadState =
        loadStateRaw === "load" ||
        loadStateRaw === "domcontentloaded" ||
        loadStateRaw === "networkidle"
          ? loadStateRaw
          : undefined;
      const timeMs = normalizeBoundedNonNegativeMs(
        raw.timeMs,
        "wait timeMs",
        MAX_BATCH_WAIT_TIME_MS,
      );
      const text = toStringOrEmpty(raw.text) || undefined;
      const textGone = toStringOrEmpty(raw.textGone) || undefined;
      const selector = toStringOrEmpty(raw.selector) || undefined;
      const url = toStringOrEmpty(raw.url) || undefined;
      const fn = toStringOrEmpty(raw.fn) || undefined;
      if (timeMs === undefined && !text && !textGone && !selector && !url && !loadState && !fn) {
        throw new Error(
          "wait requires at least one of: timeMs, text, textGone, selector, url, loadState, fn",
        );
      }
      const targetId = toStringOrEmpty(raw.targetId) || undefined;
      const timeoutMs = toNumber(raw.timeoutMs);
      return {
        kind,
        ...(timeMs !== undefined ? { timeMs } : {}),
        ...(text ? { text } : {}),
        ...(textGone ? { textGone } : {}),
        ...(selector ? { selector } : {}),
        ...(url ? { url } : {}),
        ...(loadState ? { loadState } : {}),
        ...(fn ? { fn } : {}),
        ...(targetId ? { targetId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "evaluate": {
      const fn = toStringOrEmpty(raw.fn);
      if (!fn) {
        throw new Error("evaluate requires fn");
      }
      const ref = toStringOrEmpty(raw.ref) || undefined;
      const targetId = toStringOrEmpty(raw.targetId) || undefined;
      const timeoutMs = toNumber(raw.timeoutMs);
      return {
        kind,
        fn,
        ...(ref ? { ref } : {}),
        ...(targetId ? { targetId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "close": {
      const targetId = toStringOrEmpty(raw.targetId) || undefined;
      return {
        kind,
        ...(targetId ? { targetId } : {}),
      };
    }
    case "batch": {
      const actions = Array.isArray(raw.actions) ? raw.actions.map(normalizeBatchAction) : [];
      if (!actions.length) {
        throw new Error("batch requires actions");
      }
      if (countBatchActions(actions) > MAX_BATCH_ACTIONS) {
        throw new Error(`batch exceeds maximum of ${MAX_BATCH_ACTIONS} actions`);
      }
      const targetId = toStringOrEmpty(raw.targetId) || undefined;
      const stopOnError = toBoolean(raw.stopOnError);
      return {
        kind,
        actions,
        ...(targetId ? { targetId } : {}),
        ...(stopOnError !== undefined ? { stopOnError } : {}),
      };
    }
  }
}

export function registerBrowserAgentActRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/act", async (req, res) => {
    const body = readBody(req);
    const kindRaw = toStringOrEmpty(body.kind);
    if (!isActKind(kindRaw)) {
      return jsonError(res, 400, "kind is required");
    }
    const kind: ActKind = kindRaw;
    const targetId = resolveTargetIdFromBody(body);
    if (Object.hasOwn(body, "selector") && !SELECTOR_ALLOWED_KINDS.has(kind)) {
      return jsonError(res, 400, SELECTOR_UNSUPPORTED_MESSAGE);
    }
    const earlyFn = kind === "wait" || kind === "evaluate" ? toStringOrEmpty(body.fn) : "";
    if (
      (kind === "evaluate" || (kind === "wait" && earlyFn)) &&
      !ctx.state().resolved.evaluateEnabled
    ) {
      return jsonError(
        res,
        403,
        browserEvaluateDisabledMessage(kind === "evaluate" ? "evaluate" : "wait"),
      );
    }

    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      run: async ({ profileCtx, cdpUrl, tab }) => {
        const evaluateEnabled = ctx.state().resolved.evaluateEnabled;
        const isExistingSession = getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp;
        const profileName = profileCtx.profile.name;

        switch (kind) {
          case "click": {
            const ref = readActRef(body);
            const selector = readActSelector(body);
            if (!ref && !selector) {
              return jsonError(res, 400, "ref or selector is required");
            }
            const doubleClick = toBoolean(body.doubleClick) ?? false;
            const timeoutMs = toNumber(body.timeoutMs);
            const delayMs = toNumber(body.delayMs);
            const buttonRaw = toStringOrEmpty(body.button) || "";
            const button = buttonRaw ? parseClickButton(buttonRaw) : undefined;
            if (buttonRaw && !button) {
              return jsonError(res, 400, "button must be left|right|middle");
            }

            const modifiersRaw = toStringArray(body.modifiers) ?? [];
            const parsedModifiers = parseClickModifiers(modifiersRaw);
            if (parsedModifiers.error) {
              return jsonError(res, 400, parsedModifiers.error);
            }
            const modifiers = parsedModifiers.modifiers;
            if (isExistingSession) {
              if (selector) {
                if (doubleClick) {
                  return jsonError(
                    res,
                    501,
                    "existing-session selector click does not support doubleClick yet; use ref.",
                  );
                }
                // Existing-session Chrome MCP clicks are ref-based, but the agent can still
                // surface CSS selectors on hostile sites. Fall back to page-context clicking
                // so we can keep moving instead of hard-failing on selector-only actions.
                await evaluateChromeMcpScript({
                  profileName,
                  userDataDir: profileCtx.profile.userDataDir,
                  targetId: tab.targetId,
                  fn: buildExistingSessionClickSelectorScript(selector),
                  timeoutMs: timeoutMs ?? undefined,
                });
                return res.json({ ok: true, targetId: tab.targetId, url: tab.url });
              }
              if ((button && button !== "left") || (modifiers && modifiers.length > 0)) {
                return jsonError(
                  res,
                  501,
                  "existing-session click currently supports left-click only (no button overrides/modifiers).",
                );
              }
              await runExistingSessionElementActionWithSnapshotRetry({
                kind,
                profileName,
                userDataDir: profileCtx.profile.userDataDir,
                targetId: tab.targetId,
                run: async () => {
                  try {
                    await clickChromeMcpElement({
                      profileName,
                      userDataDir: profileCtx.profile.userDataDir,
                      targetId: tab.targetId,
                      uid: ref!,
                      doubleClick,
                      timeoutMs: timeoutMs ?? undefined,
                    });
                  } catch (err) {
                    if (
                      doubleClick ||
                      !looksLikeHumanTextRef(ref!) ||
                      !isExistingSessionMissingUidError(err, ref!)
                    ) {
                      throw err;
                    }
                    // Models sometimes put visible option text in ref when Chrome MCP
                    // wanted a uid. Keep the recovery exact and text-only so real uid
                    // failures still surface instead of clicking a random fuzzy match.
                    await clickExistingSessionTextRef({
                      profileName,
                      userDataDir: profileCtx.profile.userDataDir,
                      targetId: tab.targetId,
                      text: ref!,
                      timeoutMs: timeoutMs ?? undefined,
                    });
                  }
                },
              });
              return res.json({ ok: true, targetId: tab.targetId, url: tab.url });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            const clickRequest: Parameters<typeof pw.clickViaPlaywright>[0] = {
              cdpUrl,
              targetId: tab.targetId,
              doubleClick,
            };
            if (ref) {
              clickRequest.ref = ref;
            }
            if (selector) {
              clickRequest.selector = selector;
            }
            if (button) {
              clickRequest.button = button;
            }
            if (modifiers) {
              clickRequest.modifiers = modifiers;
            }
            if (delayMs) {
              clickRequest.delayMs = delayMs;
            }
            if (timeoutMs) {
              clickRequest.timeoutMs = timeoutMs;
            }
            try {
              await pw.clickViaPlaywright(clickRequest);
            } catch (err) {
              if (
                !isPlaywrightCdpAttachTimeout(err) ||
                !canFallbackClickViaCdp({ ref, selector, wsUrl: tab.wsUrl })
              ) {
                throw err;
              }
              // Raw accessibility snapshots produce axNN refs backed by Chrome's
              // backend DOM ids. If full-browser Playwright attach stalls but the
              // tab WebSocket is healthy, use that narrower channel instead of
              // forcing the agent into unrelated macOS GUI automation.
              await clickAriaRefViaCdp({
                wsUrl: tab.wsUrl ?? "",
                ref: ref!,
                doubleClick,
                button,
                modifiers,
              });
            }
            return res.json({ ok: true, targetId: tab.targetId, url: tab.url });
          }
          case "type":
          case "paste": {
            const ref = readActRef(body);
            const selector = readActSelector(body);
            if (!ref && !selector) {
              return jsonError(res, 400, "ref or selector is required");
            }
            if (typeof body.text !== "string") {
              return jsonError(res, 400, "text is required");
            }
            const text = body.text;
            const submit = toBoolean(body.submit) ?? false;
            const slowly = toBoolean(body.slowly) ?? false;
            const clear = toBoolean(body.clear) ?? false;
            const timeoutMs = toNumber(body.timeoutMs);
            if (isExistingSession) {
              if (kind === "paste") {
                const fn = buildExistingSessionPasteScript({
                  selector,
                  value: text,
                  clear,
                });
                if (selector) {
                  await evaluateChromeMcpScript({
                    profileName,
                    userDataDir: profileCtx.profile.userDataDir,
                    targetId: tab.targetId,
                    fn,
                    timeoutMs: timeoutMs ?? undefined,
                  });
                } else {
                  const pasteRef = ref!;
                  await runExistingSessionElementActionWithSnapshotRetry({
                    kind,
                    profileName,
                    userDataDir: profileCtx.profile.userDataDir,
                    targetId: tab.targetId,
                    run: async () => {
                      await evaluateChromeMcpScript({
                        profileName,
                        userDataDir: profileCtx.profile.userDataDir,
                        targetId: tab.targetId,
                        fn,
                        args: [pasteRef],
                        timeoutMs: timeoutMs ?? undefined,
                      });
                    },
                  });
                }
                if (submit) {
                  await pressChromeMcpKey({
                    profileName,
                    userDataDir: profileCtx.profile.userDataDir,
                    targetId: tab.targetId,
                    key: "Enter",
                    timeoutMs: timeoutMs ?? undefined,
                  });
                }
                return res.json({ ok: true, targetId: tab.targetId });
              }
              if (selector) {
                await evaluateChromeMcpScript({
                  profileName,
                  userDataDir: profileCtx.profile.userDataDir,
                  targetId: tab.targetId,
                  fn: buildExistingSessionTypeSelectorScript(selector, text),
                  timeoutMs: timeoutMs ?? undefined,
                });
                if (submit) {
                  await pressChromeMcpKey({
                    profileName,
                    userDataDir: profileCtx.profile.userDataDir,
                    targetId: tab.targetId,
                    key: "Enter",
                    timeoutMs: timeoutMs ?? undefined,
                  });
                }
                return res.json({
                  ok: true,
                  targetId: tab.targetId,
                  normalized: slowly ? { slowly: false } : undefined,
                });
              }
              await runExistingSessionElementActionWithSnapshotRetry({
                kind,
                profileName,
                userDataDir: profileCtx.profile.userDataDir,
                targetId: tab.targetId,
                run: async () => {
                  await fillChromeMcpElement({
                    profileName,
                    userDataDir: profileCtx.profile.userDataDir,
                    targetId: tab.targetId,
                    uid: ref!,
                    value: text,
                    timeoutMs: timeoutMs ?? undefined,
                  });
                },
              });
              if (submit) {
                await pressChromeMcpKey({
                  profileName,
                  userDataDir: profileCtx.profile.userDataDir,
                  targetId: tab.targetId,
                  key: "Enter",
                  timeoutMs: timeoutMs ?? undefined,
                });
              }
              return res.json({
                ok: true,
                targetId: tab.targetId,
                normalized: slowly ? { slowly: false } : undefined,
              });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            const typeRequest: Parameters<typeof pw.typeViaPlaywright>[0] = {
              cdpUrl,
              targetId: tab.targetId,
              text,
              submit,
              slowly,
            };
            if (ref) {
              typeRequest.ref = ref;
            }
            if (selector) {
              typeRequest.selector = selector;
            }
            if (timeoutMs) {
              typeRequest.timeoutMs = timeoutMs;
            }
            if (kind === "paste") {
              await pw.pasteViaPlaywright({
                cdpUrl,
                targetId: tab.targetId,
                ...(ref ? { ref } : {}),
                ...(selector ? { selector } : {}),
                text,
                clear,
                submit,
                ...(timeoutMs ? { timeoutMs } : {}),
              });
            } else {
              await pw.typeViaPlaywright(typeRequest);
            }
            return res.json({ ok: true, targetId: tab.targetId });
          }
          case "press": {
            const key = toStringOrEmpty(body.key);
            if (!key) {
              return jsonError(res, 400, "key is required");
            }
            const ref = readActRef(body);
            const selector = readActSelector(body);
            const delayMs = toNumber(body.delayMs);
            const timeoutMs = toNumber(body.timeoutMs);
            if (isExistingSession) {
              if (delayMs) {
                return jsonError(res, 501, "existing-session press does not support delayMs.");
              }
              await focusExistingSessionPressTarget({
                profileName,
                userDataDir: profileCtx.profile.userDataDir,
                targetId: tab.targetId,
                ref,
                selector,
                timeoutMs: timeoutMs ?? undefined,
              });
              await pressChromeMcpKey({
                profileName,
                userDataDir: profileCtx.profile.userDataDir,
                targetId: tab.targetId,
                key,
                timeoutMs: timeoutMs ?? undefined,
              });
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            await pw.pressKeyViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              ref,
              selector,
              key,
              delayMs: delayMs ?? undefined,
              timeoutMs: timeoutMs ?? undefined,
            });
            return res.json({ ok: true, targetId: tab.targetId });
          }
          case "hover": {
            const ref = readActRef(body);
            const selector = readActSelector(body);
            if (!ref && !selector) {
              return jsonError(res, 400, "ref or selector is required");
            }
            const timeoutMs = toNumber(body.timeoutMs);
            if (isExistingSession) {
              if (selector) {
                return jsonError(
                  res,
                  501,
                  "existing-session hover does not support selector targeting yet; use ref.",
                );
              }
              await runExistingSessionElementActionWithSnapshotRetry({
                kind,
                profileName,
                userDataDir: profileCtx.profile.userDataDir,
                targetId: tab.targetId,
                run: async () => {
                  await hoverChromeMcpElement({
                    profileName,
                    userDataDir: profileCtx.profile.userDataDir,
                    targetId: tab.targetId,
                    uid: ref!,
                    timeoutMs: timeoutMs ?? undefined,
                  });
                },
              });
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            await pw.hoverViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              ref,
              selector,
              timeoutMs: timeoutMs ?? undefined,
            });
            return res.json({ ok: true, targetId: tab.targetId });
          }
          case "scrollIntoView": {
            const ref = readActRef(body);
            const selector = readActSelector(body);
            if (!ref && !selector) {
              return jsonError(res, 400, "ref or selector is required");
            }
            const timeoutMs = toNumber(body.timeoutMs);
            if (isExistingSession) {
              if (selector) {
                return jsonError(
                  res,
                  501,
                  "existing-session scrollIntoView does not support selector targeting yet; use ref.",
                );
              }
              // The existing-session scroll path is a direct in-page
              // scrollIntoView call. Chrome MCP has no separate scroll wait to
              // tune, so ignore generic timeout overrides and perform the
              // deterministic scroll instead of hard-failing.
              await evaluateChromeMcpScript({
                profileName,
                userDataDir: profileCtx.profile.userDataDir,
                targetId: tab.targetId,
                fn: `(el) => { el.scrollIntoView({ block: "center", inline: "center" }); return true; }`,
                args: [ref!],
                timeoutMs: timeoutMs ?? undefined,
              });
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            const scrollRequest: Parameters<typeof pw.scrollIntoViewViaPlaywright>[0] = {
              cdpUrl,
              targetId: tab.targetId,
            };
            if (ref) {
              scrollRequest.ref = ref;
            }
            if (selector) {
              scrollRequest.selector = selector;
            }
            if (timeoutMs) {
              scrollRequest.timeoutMs = timeoutMs;
            }
            await pw.scrollIntoViewViaPlaywright(scrollRequest);
            return res.json({ ok: true, targetId: tab.targetId });
          }
          case "drag": {
            const startRef = toStringOrEmpty(body.startRef) || undefined;
            const startSelector = toStringOrEmpty(body.startSelector) || undefined;
            const endRef = toStringOrEmpty(body.endRef) || undefined;
            const endSelector = toStringOrEmpty(body.endSelector) || undefined;
            if (!startRef && !startSelector) {
              return jsonError(res, 400, "startRef or startSelector is required");
            }
            if (!endRef && !endSelector) {
              return jsonError(res, 400, "endRef or endSelector is required");
            }
            const timeoutMs = toNumber(body.timeoutMs);
            if (isExistingSession) {
              if (startSelector || endSelector) {
                return jsonError(
                  res,
                  501,
                  "existing-session drag does not support selector targeting yet; use startRef/endRef.",
                );
              }
              await dragChromeMcpElement({
                profileName,
                userDataDir: profileCtx.profile.userDataDir,
                targetId: tab.targetId,
                fromUid: startRef!,
                toUid: endRef!,
                timeoutMs: timeoutMs ?? undefined,
              });
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            await pw.dragViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              startRef,
              startSelector,
              endRef,
              endSelector,
              timeoutMs: timeoutMs ?? undefined,
            });
            return res.json({ ok: true, targetId: tab.targetId });
          }
          case "select": {
            const ref = readActRef(body);
            const selector = readActSelector(body);
            const values = toStringArray(body.values);
            if ((!ref && !selector) || !values?.length) {
              return jsonError(res, 400, "ref/selector and values are required");
            }
            const timeoutMs = toNumber(body.timeoutMs);
            if (isExistingSession) {
              if (selector) {
                return jsonError(
                  res,
                  501,
                  "existing-session select does not support selector targeting yet; use ref.",
                );
              }
              if (values.length !== 1) {
                return jsonError(
                  res,
                  501,
                  "existing-session select currently supports a single value only.",
                );
              }
              await runExistingSessionElementActionWithSnapshotRetry({
                kind,
                profileName,
                userDataDir: profileCtx.profile.userDataDir,
                targetId: tab.targetId,
                run: async () => {
                  await fillChromeMcpElement({
                    profileName,
                    userDataDir: profileCtx.profile.userDataDir,
                    targetId: tab.targetId,
                    uid: ref!,
                    value: values[0] ?? "",
                    timeoutMs: timeoutMs ?? undefined,
                  });
                },
              });
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            await pw.selectOptionViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              ref,
              selector,
              values,
              timeoutMs: timeoutMs ?? undefined,
            });
            return res.json({ ok: true, targetId: tab.targetId });
          }
          case "chooseOption": {
            const ref = readActRef(body);
            const selector = readActSelector(body);
            const optionText = toStringOrEmpty(body.optionText);
            if ((!ref && !selector) || !optionText) {
              return jsonError(res, 400, "ref/selector and optionText are required");
            }
            const query = toStringOrEmpty(body.query) || optionText;
            const match = parseChooseOptionMatchMode(body.match) ?? "exact";
            const timeoutMs = toNumber(body.timeoutMs);
            if (isExistingSession) {
              const result = await evaluateChromeMcpScript({
                profileName,
                userDataDir: profileCtx.profile.userDataDir,
                targetId: tab.targetId,
                fn: buildExistingSessionChooseOptionScript({
                  target: selector ? "selector" : "ref",
                  selector,
                  optionText,
                  matchMode: match,
                  queryText: query,
                  timeoutMs: Math.max(500, Math.min(60000, timeoutMs ?? 10_000)),
                }),
                args: ref && !selector ? [ref] : undefined,
                timeoutMs: timeoutMs ?? undefined,
              });
              const resultError = validateExistingSessionChooseOptionResult({
                result,
                optionText,
                matchMode: match,
              });
              if (resultError) {
                return jsonError(res, 400, resultError);
              }
              return res.json({ ok: true, targetId: tab.targetId, url: tab.url, result });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            const result = await pw.chooseOptionViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              ref,
              selector,
              optionText,
              query,
              match,
              timeoutMs: timeoutMs ?? undefined,
            });
            return res.json({ ok: true, targetId: tab.targetId, url: tab.url, result });
          }
          case "fill": {
            const rawFields = Array.isArray(body.fields) ? body.fields : [];
            const fields = rawFields
              .map((field) => {
                if (!field || typeof field !== "object") {
                  return null;
                }
                return normalizeBrowserFormField(field as Record<string, unknown>);
              })
              .filter((field): field is BrowserFormField => field !== null);
            if (!fields.length) {
              return jsonError(res, 400, "fields are required");
            }
            const timeoutMs = toNumber(body.timeoutMs);
            if (isExistingSession) {
              const refFields = fields.filter(
                (field): field is BrowserFormField & { ref: string } =>
                  typeof field.ref === "string",
              );
              const selectorFields = fields.filter(
                (field): field is BrowserFormField & { selector: string } =>
                  typeof field.selector === "string" && field.selector.trim().length > 0,
              );
              if (refFields.length) {
                await fillChromeMcpForm({
                  profileName,
                  userDataDir: profileCtx.profile.userDataDir,
                  targetId: tab.targetId,
                  elements: refFields.map((field) => ({
                    uid: field.ref,
                    value: String(field.value ?? ""),
                  })),
                  timeoutMs: timeoutMs ?? undefined,
                });
              }
              for (const field of selectorFields) {
                // Existing-session Chrome MCP only fills by ref. When the agent only has a
                // selector, use page-context DOM writes so we do not discard an otherwise
                // valid form action.
                await evaluateChromeMcpScript({
                  profileName,
                  userDataDir: profileCtx.profile.userDataDir,
                  targetId: tab.targetId,
                  fn: buildExistingSessionFillSelectorScript(
                    field.selector,
                    String(field.value ?? ""),
                  ),
                  timeoutMs: timeoutMs ?? undefined,
                });
              }
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            await pw.fillFormViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              fields,
              timeoutMs: timeoutMs ?? undefined,
            });
            return res.json({ ok: true, targetId: tab.targetId });
          }
          case "resize": {
            const width = toNumber(body.width);
            const height = toNumber(body.height);
            if (!width || !height) {
              return jsonError(res, 400, "width and height are required");
            }
            if (isExistingSession) {
              await resizeChromeMcpPage({
                profileName,
                userDataDir: profileCtx.profile.userDataDir,
                targetId: tab.targetId,
                width,
                height,
              });
              return res.json({ ok: true, targetId: tab.targetId, url: tab.url });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            await pw.resizeViewportViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              width,
              height,
            });
            return res.json({ ok: true, targetId: tab.targetId, url: tab.url });
          }
          case "wait": {
            const timeMs = toNumber(body.timeMs);
            const text = toStringOrEmpty(body.text) || undefined;
            const textGone = toStringOrEmpty(body.textGone) || undefined;
            const selector = toStringOrEmpty(body.selector) || undefined;
            const url = toStringOrEmpty(body.url) || undefined;
            const loadStateRaw = toStringOrEmpty(body.loadState);
            const loadState =
              loadStateRaw === "load" ||
              loadStateRaw === "domcontentloaded" ||
              loadStateRaw === "networkidle"
                ? loadStateRaw
                : undefined;
            const fn = toStringOrEmpty(body.fn) || undefined;
            const timeoutMs = toNumber(body.timeoutMs) ?? undefined;
            if (fn && !evaluateEnabled) {
              return jsonError(res, 403, browserEvaluateDisabledMessage("wait"));
            }
            if (
              timeMs === undefined &&
              !text &&
              !textGone &&
              !selector &&
              !url &&
              !loadState &&
              !fn
            ) {
              return jsonError(
                res,
                400,
                "wait requires at least one of: timeMs, text, textGone, selector, url, loadState, fn",
              );
            }
            if (isExistingSession) {
              await waitForExistingSessionCondition({
                profileName,
                userDataDir: profileCtx.profile.userDataDir,
                targetId: tab.targetId,
                timeMs,
                text,
                textGone,
                selector,
                url,
                loadState,
                fn,
                timeoutMs,
              });
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            await pw.waitForViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              timeMs,
              text,
              textGone,
              selector,
              url,
              loadState,
              fn,
              timeoutMs,
            });
            return res.json({ ok: true, targetId: tab.targetId });
          }
          case "evaluate": {
            if (!evaluateEnabled) {
              return jsonError(res, 403, browserEvaluateDisabledMessage("evaluate"));
            }
            const fn = toStringOrEmpty(body.fn);
            if (!fn) {
              return jsonError(res, 400, "fn is required");
            }
            const ref = toStringOrEmpty(body.ref) || undefined;
            const evalTimeoutMs = toNumber(body.timeoutMs);
            if (isExistingSession) {
              const result = await evaluateChromeMcpScript({
                profileName,
                userDataDir: profileCtx.profile.userDataDir,
                targetId: tab.targetId,
                fn,
                args: ref ? [ref] : undefined,
                timeoutMs: evalTimeoutMs ?? undefined,
              });
              return res.json({
                ok: true,
                targetId: tab.targetId,
                url: tab.url,
                result,
              });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            const evalRequest: Parameters<typeof pw.evaluateViaPlaywright>[0] = {
              cdpUrl,
              targetId: tab.targetId,
              fn,
              ref,
              signal: req.signal,
            };
            if (evalTimeoutMs !== undefined) {
              evalRequest.timeoutMs = evalTimeoutMs;
            }
            const result = await pw.evaluateViaPlaywright(evalRequest);
            return res.json({
              ok: true,
              targetId: tab.targetId,
              url: tab.url,
              result,
            });
          }
          case "close": {
            if (isExistingSession) {
              await closeChromeMcpTab(profileName, tab.targetId, profileCtx.profile.userDataDir);
              return res.json({ ok: true, targetId: tab.targetId });
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            await pw.closePageViaPlaywright({ cdpUrl, targetId: tab.targetId });
            return res.json({ ok: true, targetId: tab.targetId });
          }
          case "batch": {
            if (isExistingSession) {
              return jsonError(
                res,
                501,
                "existing-session batch is not supported yet; send actions individually.",
              );
            }
            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            let actions: BrowserActRequest[];
            try {
              actions = Array.isArray(body.actions) ? body.actions.map(normalizeBatchAction) : [];
            } catch (err) {
              return jsonError(res, 400, err instanceof Error ? err.message : String(err));
            }
            if (!actions.length) {
              return jsonError(res, 400, "actions are required");
            }
            if (countBatchActions(actions) > MAX_BATCH_ACTIONS) {
              return jsonError(res, 400, `batch exceeds maximum of ${MAX_BATCH_ACTIONS} actions`);
            }
            const targetIdError = validateBatchTargetIds(actions, tab.targetId);
            if (targetIdError) {
              return jsonError(res, 403, targetIdError);
            }
            const stopOnError = toBoolean(body.stopOnError) ?? true;
            const result = await pw.batchViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              actions,
              stopOnError,
              evaluateEnabled,
            });
            return res.json({ ok: true, targetId: tab.targetId, results: result.results });
          }
          default: {
            return jsonError(res, 400, "unsupported kind");
          }
        }
      },
    });
  });

  registerBrowserAgentActHookRoutes(app, ctx);
  registerBrowserAgentActDownloadRoutes(app, ctx);

  app.post("/response/body", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const url = toStringOrEmpty(body.url);
    const timeoutMs = toNumber(body.timeoutMs);
    const maxChars = toNumber(body.maxChars);
    if (!url) {
      return jsonError(res, 400, "url is required");
    }

    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      run: async ({ profileCtx, cdpUrl, tab }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          return jsonError(
            res,
            501,
            "response body is not supported for existing-session profiles yet.",
          );
        }
        const pw = await requirePwAi(res, "response body");
        if (!pw) {
          return;
        }
        const result = await pw.responseBodyViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          url,
          timeoutMs: timeoutMs ?? undefined,
          maxChars: maxChars ?? undefined,
        });
        res.json({ ok: true, targetId: tab.targetId, response: result });
      },
    });
  });

  app.post("/highlight", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const ref = toStringOrEmpty(body.ref);
    if (!ref) {
      return jsonError(res, 400, "ref is required");
    }

    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      run: async ({ profileCtx, cdpUrl, tab }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          await evaluateChromeMcpScript({
            profileName: profileCtx.profile.name,
            userDataDir: profileCtx.profile.userDataDir,
            targetId: tab.targetId,
            args: [ref],
            fn: `(el) => {
              if (!(el instanceof Element)) {
                return false;
              }
              el.scrollIntoView({ block: "center", inline: "center" });
              const previousOutline = el.style.outline;
              const previousOffset = el.style.outlineOffset;
              el.style.outline = "3px solid #FF4500";
              el.style.outlineOffset = "2px";
              setTimeout(() => {
                el.style.outline = previousOutline;
                el.style.outlineOffset = previousOffset;
              }, 2000);
              return true;
            }`,
          });
          return res.json({ ok: true, targetId: tab.targetId });
        }
        const pw = await requirePwAi(res, "highlight");
        if (!pw) {
          return;
        }
        await pw.highlightViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          ref,
        });
        res.json({ ok: true, targetId: tab.targetId });
      },
    });
  });
}
