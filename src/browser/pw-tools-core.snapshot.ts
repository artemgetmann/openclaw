import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { type AriaSnapshotNode, formatAriaSnapshot, type RawAXNode } from "./cdp.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import {
  buildRoleSnapshotFromAiSnapshot,
  buildRoleSnapshotFromAriaSnapshot,
  getRoleSnapshotStats,
  type RoleSnapshotOptions,
  type RoleRefMap,
} from "./pw-role-snapshot.js";
import {
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  storeRoleRefsForTarget,
  type WithSnapshotForAI,
} from "./pw-session.js";
import { withPageScopedCdpClient } from "./pw-session.page-cdp.js";

type PdfResourceCandidate = { frameId: string; url: string };
type NativePdfResourceResult = { buffer: Buffer; url: string };

class NativePdfResourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativePdfResourceUnavailableError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function isPdfMime(mimeType: unknown): boolean {
  if (typeof mimeType !== "string") {
    return false;
  }
  return mimeType.split(";")[0]?.trim().toLowerCase() === "application/pdf";
}

function decodePdfResourceContent(result: unknown): Buffer {
  const record = asRecord(result);
  const content = typeof record?.content === "string" ? record.content : "";
  if (!content) {
    return Buffer.alloc(0);
  }
  return record?.base64Encoded === true ? Buffer.from(content, "base64") : Buffer.from(content);
}

function collectPdfResourceCandidates(frameTree: unknown): PdfResourceCandidate[] {
  const candidates: PdfResourceCandidate[] = [];

  const visit = (node: unknown): void => {
    const tree = asRecord(node);
    const frame = asRecord(tree?.frame);
    const frameId = typeof frame?.id === "string" ? frame.id : "";
    const frameUrl = typeof frame?.url === "string" ? frame.url : "";

    // Chrome's PDF viewer can surface the native PDF either as the current
    // frame or as a resource owned by the viewer frame. Treat either as a
    // native-byte candidate before considering any print fallback.
    if (frameId && frameUrl && isPdfMime(frame?.mimeType)) {
      candidates.push({ frameId, url: frameUrl });
    }

    const resources = Array.isArray(tree?.resources) ? tree.resources : [];
    for (const resource of resources) {
      const rec = asRecord(resource);
      const url = typeof rec?.url === "string" ? rec.url : "";
      if (frameId && url && isPdfMime(rec?.mimeType)) {
        candidates.push({ frameId, url });
      }
    }

    const childFrames = Array.isArray(tree?.childFrames) ? tree.childFrames : [];
    for (const childFrame of childFrames) {
      visit(childFrame);
    }
  };

  visit(frameTree);
  return candidates;
}

function assertNativePdfBuffer(buffer: Buffer, url: string): void {
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error(`Chrome resource for "${url}" was not a native PDF payload`);
  }
}

async function readLoadedNativePdfResourceViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  page: Awaited<ReturnType<typeof getPageForTargetId>>;
}): Promise<NativePdfResourceResult | undefined> {
  return await withPageScopedCdpClient({
    cdpUrl: opts.cdpUrl,
    page: opts.page,
    targetId: opts.targetId,
    fn: async (send) => {
      let resourceTreeResult: Record<string, unknown> | undefined;
      try {
        // Some Chrome targets require the Page domain before resource APIs work.
        // Failure here is not itself proof that the page is a PDF, so keep HTML
        // page printing available when there are no observable PDF resources.
        await send("Page.enable").catch(() => {});
        resourceTreeResult = asRecord(await send("Page.getResourceTree"));
      } catch {
        return undefined;
      }

      const candidates = collectPdfResourceCandidates(resourceTreeResult?.frameTree);
      if (candidates.length === 0) {
        return undefined;
      }

      const errors: string[] = [];
      for (const candidate of candidates) {
        try {
          const contentResult = await send("Page.getResourceContent", {
            frameId: candidate.frameId,
            url: candidate.url,
          });
          const buffer = decodePdfResourceContent(contentResult);
          assertNativePdfBuffer(buffer, candidate.url);
          return { buffer, url: candidate.url };
        } catch (err) {
          errors.push(`${candidate.url}: ${String(err instanceof Error ? err.message : err)}`);
        }
      }

      throw new NativePdfResourceUnavailableError(
        [
          "Current tab contains an application/pdf resource, but Chrome did not expose the native PDF bytes from the loaded resource.",
          "Refusing to print the Chrome PDF viewer UI as a PDF.",
          "Arm browser download/PDF capture before the click or navigation that creates the PDF, then retry.",
          `Details: ${errors.join("; ")}`,
        ].join(" "),
      );
    },
  });
}

function resolveSnapshotTimeoutMs(timeoutMs: number | undefined): number {
  return Math.max(500, Math.min(60_000, Math.floor(timeoutMs ?? 5000)));
}

export async function snapshotAriaViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  limit?: number;
}): Promise<{ nodes: AriaSnapshotNode[] }> {
  const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 500)));
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);
  const res = (await withPageScopedCdpClient({
    cdpUrl: opts.cdpUrl,
    page,
    targetId: opts.targetId,
    fn: async (send) => {
      await send("Accessibility.enable").catch(() => {});
      return (await send("Accessibility.getFullAXTree")) as {
        nodes?: RawAXNode[];
      };
    },
  })) as {
    nodes?: RawAXNode[];
  };
  const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
  return { nodes: formatAriaSnapshot(nodes, limit) };
}

export async function snapshotAiViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timeoutMs?: number;
  maxChars?: number;
}): Promise<{ snapshot: string; truncated?: boolean; refs: RoleRefMap }> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);

  const maybe = page as unknown as WithSnapshotForAI;
  if (!maybe._snapshotForAI) {
    throw new Error("Playwright _snapshotForAI is not available. Upgrade playwright-core.");
  }

  const result = await maybe._snapshotForAI({
    timeout: resolveSnapshotTimeoutMs(opts.timeoutMs),
    track: "response",
  });
  let snapshot = String(result?.full ?? "");
  const maxChars = opts.maxChars;
  const limit =
    typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0
      ? Math.floor(maxChars)
      : undefined;
  let truncated = false;
  if (limit && snapshot.length > limit) {
    snapshot = `${snapshot.slice(0, limit)}\n\n[...TRUNCATED - page too large]`;
    truncated = true;
  }

  const built = buildRoleSnapshotFromAiSnapshot(snapshot);
  storeRoleRefsForTarget({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: built.refs,
    mode: "aria",
  });
  return truncated ? { snapshot, truncated, refs: built.refs } : { snapshot, refs: built.refs };
}

export async function snapshotRoleViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  selector?: string;
  frameSelector?: string;
  refsMode?: "role" | "aria";
  timeoutMs?: number;
  options?: RoleSnapshotOptions;
}): Promise<{
  snapshot: string;
  refs: Record<string, { role: string; name?: string; nth?: number }>;
  stats: { lines: number; chars: number; refs: number; interactive: number };
}> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);

  if (opts.refsMode === "aria") {
    if (opts.selector?.trim() || opts.frameSelector?.trim()) {
      throw new Error("refs=aria does not support selector/frame snapshots yet.");
    }
    const maybe = page as unknown as WithSnapshotForAI;
    if (!maybe._snapshotForAI) {
      throw new Error("refs=aria requires Playwright _snapshotForAI support.");
    }
    const result = await maybe._snapshotForAI({
      timeout: resolveSnapshotTimeoutMs(opts.timeoutMs),
      track: "response",
    });
    const built = buildRoleSnapshotFromAiSnapshot(String(result?.full ?? ""), opts.options);
    storeRoleRefsForTarget({
      page,
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      refs: built.refs,
      mode: "aria",
    });
    return {
      snapshot: built.snapshot,
      refs: built.refs,
      stats: getRoleSnapshotStats(built.snapshot, built.refs),
    };
  }

  const frameSelector = opts.frameSelector?.trim() || "";
  const selector = opts.selector?.trim() || "";
  const locator = frameSelector
    ? selector
      ? page.frameLocator(frameSelector).locator(selector)
      : page.frameLocator(frameSelector).locator(":root")
    : selector
      ? page.locator(selector)
      : page.locator(":root");

  const ariaSnapshot = await locator.ariaSnapshot();
  const built = buildRoleSnapshotFromAriaSnapshot(String(ariaSnapshot ?? ""), opts.options);
  storeRoleRefsForTarget({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: built.refs,
    frameSelector: frameSelector || undefined,
    mode: "role",
  });
  return {
    snapshot: built.snapshot,
    refs: built.refs,
    stats: getRoleSnapshotStats(built.snapshot, built.refs),
  };
}

export async function navigateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ url: string }> {
  const isRetryableNavigateError = (err: unknown): boolean => {
    const msg =
      typeof err === "string"
        ? err.toLowerCase()
        : err instanceof Error
          ? err.message.toLowerCase()
          : "";
    return (
      msg.includes("frame has been detached") ||
      msg.includes("target page, context or browser has been closed")
    );
  };

  const url = String(opts.url ?? "").trim();
  if (!url) {
    throw new Error("url is required");
  }
  await assertBrowserNavigationAllowed({
    url,
    ...withBrowserNavigationPolicy(opts.ssrfPolicy),
  });
  const timeout = Math.max(1000, Math.min(120_000, opts.timeoutMs ?? 20_000));
  let page = await getPageForTargetId(opts);
  ensurePageState(page);
  const navigate = async () => await page.goto(url, { timeout });
  let response;
  try {
    response = await navigate();
  } catch (err) {
    if (!isRetryableNavigateError(err)) {
      throw err;
    }
    // Extension relays can briefly drop CDP during renderer swaps/navigation.
    // Force a clean reconnect, then retry once on the refreshed page handle.
    await forceDisconnectPlaywrightForTarget({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      reason: "retry navigate after detached frame",
    }).catch(() => {});
    page = await getPageForTargetId(opts);
    ensurePageState(page);
    response = await navigate();
  }
  await assertBrowserNavigationRedirectChainAllowed({
    request: response?.request(),
    ...withBrowserNavigationPolicy(opts.ssrfPolicy),
  });
  const finalUrl = page.url();
  await assertBrowserNavigationResultAllowed({
    url: finalUrl,
    ...withBrowserNavigationPolicy(opts.ssrfPolicy),
  });
  return { url: finalUrl };
}

export async function resizeViewportViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  width: number;
  height: number;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.setViewportSize({
    width: Math.max(1, Math.floor(opts.width)),
    height: Math.max(1, Math.floor(opts.height)),
  });
}

export async function closePageViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.close();
}

export async function pdfViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<{ buffer: Buffer; url?: string }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const nativePdf = await readLoadedNativePdfResourceViaPlaywright({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    page,
  });
  if (nativePdf) {
    return nativePdf;
  }
  const buffer = await page.pdf({ printBackground: true });
  return { buffer };
}
