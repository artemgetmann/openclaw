import { fetch as realFetch } from "undici";
import { describe, expect, it } from "vitest";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "./constants.js";
import {
  installAgentContractHooks,
  postJson,
  startServerAndBase,
} from "./server.agent-contract.test-harness.js";
import {
  getBrowserControlServerTestState,
  getCdpMocks,
  getPwMocks,
} from "./server.control-server.test-harness.js";

const state = getBrowserControlServerTestState();
const cdpMocks = getCdpMocks();
const pwMocks = getPwMocks();

describe("browser control server", () => {
  installAgentContractHooks();

  it("agent contract: snapshot endpoints", async () => {
    const base = await startServerAndBase();

    const snapAria = (await realFetch(`${base}/snapshot?format=aria&limit=1`).then((r) =>
      r.json(),
    )) as { ok: boolean; format?: string };
    expect(snapAria.ok).toBe(true);
    expect(snapAria.format).toBe("aria");
    expect(cdpMocks.snapshotAria).toHaveBeenCalledWith({
      wsUrl: "ws://127.0.0.1/devtools/page/abcd1234",
      limit: 1,
    });

    const snapAi = (await realFetch(`${base}/snapshot?format=ai`).then((r) => r.json())) as {
      ok: boolean;
      format?: string;
    };
    expect(snapAi.ok).toBe(true);
    expect(snapAi.format).toBe("ai");
    expect(pwMocks.snapshotAiViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      maxChars: DEFAULT_AI_SNAPSHOT_MAX_CHARS,
    });

    const snapAiZero = (await realFetch(`${base}/snapshot?format=ai&maxChars=0`).then((r) =>
      r.json(),
    )) as { ok: boolean; format?: string };
    expect(snapAiZero.ok).toBe(true);
    expect(snapAiZero.format).toBe("ai");
    const [lastCall] = pwMocks.snapshotAiViaPlaywright.mock.calls.at(-1) ?? [];
    expect(lastCall).toEqual({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
    });

    const snapAiWithTimeout = (await realFetch(
      `${base}/snapshot?format=ai&targetId=abce9999&timeoutMs=42000`,
    ).then((r) => r.json())) as {
      ok: boolean;
      format?: string;
      targetId?: string;
    };
    expect(snapAiWithTimeout.ok).toBe(true);
    expect(snapAiWithTimeout.format).toBe("ai");
    expect(snapAiWithTimeout.targetId).toBe("abce9999");
    expect(pwMocks.snapshotAiViaPlaywright).toHaveBeenLastCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abce9999",
      timeoutMs: 42000,
      maxChars: DEFAULT_AI_SNAPSHOT_MAX_CHARS,
    });

    const snapRoleAriaWithTimeout = (await realFetch(
      `${base}/snapshot?format=ai&targetId=abcd1234&refs=aria&interactive=true&timeoutMs=12000`,
    ).then((r) => r.json())) as { ok: boolean; format?: string };
    expect(snapRoleAriaWithTimeout.ok).toBe(true);
    expect(snapRoleAriaWithTimeout.format).toBe("ai");
    expect(pwMocks.snapshotRoleViaPlaywright).toHaveBeenLastCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      selector: undefined,
      frameSelector: undefined,
      refsMode: "aria",
      timeoutMs: 12000,
      options: {
        interactive: true,
        compact: undefined,
        maxDepth: undefined,
      },
    });
  });

  it("agent contract: ai snapshot timeout failure recovers with exact-target raw aria fallback", async () => {
    const base = await startServerAndBase();
    pwMocks.snapshotAiViaPlaywright.mockRejectedValueOnce(
      new Error("page._snapshotForAI: Timeout 5000ms exceeded"),
    );

    const snap = (await realFetch(
      `${base}/snapshot?format=ai&targetId=abce9999&timeoutMs=30000&limit=7`,
    ).then((r) => r.json())) as {
      ok: boolean;
      format?: string;
      fallback?: string;
      targetId?: string;
      nodes?: unknown[];
    };

    expect(snap.ok).toBe(true);
    expect(snap.format).toBe("aria");
    expect(snap.fallback).toBe("raw-cdp-aria");
    expect(snap.targetId).toBe("abce9999");
    expect(Array.isArray(snap.nodes)).toBe(true);
    expect(pwMocks.snapshotAiViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abce9999",
      timeoutMs: 30000,
      maxChars: DEFAULT_AI_SNAPSHOT_MAX_CHARS,
    });
    expect(pwMocks.forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abce9999",
      reason: "recover snapshot after Playwright AI snapshot failure",
    });
    expect(cdpMocks.snapshotAria).toHaveBeenCalledWith({
      wsUrl: "ws://127.0.0.1/devtools/page/abce9999",
      limit: 7,
    });
  });

  it("agent contract: non-recoverable ai snapshot errors do not fallback to raw aria", async () => {
    const base = await startServerAndBase();
    pwMocks.snapshotAiViaPlaywright.mockRejectedValueOnce(new Error("unexpected parser failure"));

    const res = await realFetch(`${base}/snapshot?format=ai&targetId=abce9999`);
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(500);
    expect(body.error).toContain("unexpected parser failure");
    expect(pwMocks.forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();
    expect(cdpMocks.snapshotAria).not.toHaveBeenCalled();
  });

  it("agent contract: navigation + common act commands", async () => {
    const base = await startServerAndBase();

    const nav = await postJson<{ ok: boolean; targetId?: string }>(`${base}/navigate`, {
      url: "https://example.com",
    });
    expect(nav.ok).toBe(true);
    expect(typeof nav.targetId).toBe("string");
    expect(pwMocks.navigateViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: state.cdpBaseUrl,
        targetId: "abcd1234",
        url: "https://example.com",
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: true,
        },
      }),
    );

    const click = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "click",
      ref: "1",
      button: "left",
      modifiers: ["Shift"],
    });
    expect(click.ok).toBe(true);
    expect(pwMocks.clickViaPlaywright).toHaveBeenNthCalledWith(1, {
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      ref: "1",
      doubleClick: false,
      button: "left",
      modifiers: ["Shift"],
    });

    pwMocks.clickViaPlaywright.mockRejectedValueOnce(
      new Error("browserType.connectOverCDP: Timeout 15000ms exceeded"),
    );
    const fallbackClick = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "click",
      ref: "ax158",
      button: "left",
    });
    expect(fallbackClick.ok).toBe(true);
    expect(cdpMocks.clickAriaRefViaCdp).toHaveBeenCalledWith({
      wsUrl: "ws://127.0.0.1/devtools/page/abcd1234",
      ref: "ax158",
      doubleClick: false,
      button: "left",
      modifiers: undefined,
    });

    const clickSelector = await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "click", selector: "button.save" }),
    });
    expect(clickSelector.status).toBe(200);
    expect(((await clickSelector.json()) as { ok?: boolean }).ok).toBe(true);
    expect(pwMocks.clickViaPlaywright).toHaveBeenNthCalledWith(3, {
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      selector: "button.save",
      doubleClick: false,
    });

    const type = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "type",
      ref: "1",
      text: "",
    });
    expect(type.ok).toBe(true);
    expect(pwMocks.typeViaPlaywright).toHaveBeenNthCalledWith(1, {
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      ref: "1",
      text: "",
      submit: false,
      slowly: false,
    });

    const press = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "press",
      key: "Enter",
    });
    expect(press.ok).toBe(true);
    expect(pwMocks.pressKeyViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      key: "Enter",
    });

    const targetedPress = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "press",
      ref: "combo-title",
      key: "Enter",
      timeoutMs: 12000,
    });
    expect(targetedPress.ok).toBe(true);
    expect(pwMocks.pressKeyViaPlaywright).toHaveBeenLastCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      ref: "combo-title",
      selector: undefined,
      key: "Enter",
      delayMs: undefined,
      timeoutMs: 12000,
    });

    const hover = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "hover",
      ref: "2",
    });
    expect(hover.ok).toBe(true);
    expect(pwMocks.hoverViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      ref: "2",
    });

    const scroll = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "scrollIntoView",
      ref: "2",
    });
    expect(scroll.ok).toBe(true);
    expect(pwMocks.scrollIntoViewViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      ref: "2",
    });

    const drag = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "drag",
      startRef: "3",
      endRef: "4",
    });
    expect(drag.ok).toBe(true);
    expect(pwMocks.dragViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      startRef: "3",
      endRef: "4",
    });
  });
});
