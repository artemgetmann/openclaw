import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type MockLocator = {
  click: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  first?: ReturnType<typeof vi.fn>;
  locator?: ReturnType<typeof vi.fn>;
  press?: ReturnType<typeof vi.fn>;
};

let page: { keyboard: { press: ReturnType<typeof vi.fn> }; locator: ReturnType<typeof vi.fn> };
let locator: MockLocator | null = null;

const getPageForTargetId = vi.fn(async () => page);
const ensurePageState = vi.fn(() => {});
const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});
const restoreRoleRefsForTarget = vi.fn(() => {});
const refLocator = vi.fn(() => {
  if (!locator) {
    throw new Error("test: locator not set");
  }
  return locator;
});

vi.mock("./pw-session.js", () => ({
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  refLocator,
  restoreRoleRefsForTarget,
}));

let fillFormViaPlaywright: typeof import("./pw-tools-core.interactions.js").fillFormViaPlaywright;
let pressKeyViaPlaywright: typeof import("./pw-tools-core.interactions.js").pressKeyViaPlaywright;

describe("combobox-style interactions", () => {
  beforeAll(async () => {
    ({ fillFormViaPlaywright, pressKeyViaPlaywright } =
      await import("./pw-tools-core.interactions.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    locator = null;
    page = {
      keyboard: { press: vi.fn(async () => {}) },
      locator: vi.fn(() => ({
        first: vi.fn(() => ({
          fill: vi.fn(async () => {}),
        })),
      })),
    };
  });

  it("fills an editable descendant when the snapshot ref points at a combobox wrapper", async () => {
    const searchInput = { fill: vi.fn(async () => {}) };
    const descendant = {
      first: vi.fn(() => searchInput),
    };
    locator = {
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {
        throw new Error("element is not an editable element");
      }),
      locator: vi.fn(() => descendant),
    };

    await fillFormViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      fields: [{ ref: "combo-title", type: "text", value: "Mr" }],
    });

    expect(refLocator).toHaveBeenCalledWith(page, "combo-title");
    expect(locator.fill).toHaveBeenCalledWith("Mr", { timeout: 8000 });
    expect(locator.click).toHaveBeenCalledWith({ timeout: 8000 });
    expect(locator.locator).toHaveBeenCalledWith(
      'input:not([type="hidden"]), textarea, [contenteditable="true"], [role="textbox"]',
    );
    expect(descendant.first).toHaveBeenCalled();
    expect(searchInput.fill).toHaveBeenCalledWith("Mr", { timeout: 8000 });
  });

  it("presses Enter on a provided ref instead of relying on page-global focus", async () => {
    locator = {
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
      press: vi.fn(async () => {}),
    };

    await pressKeyViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      ref: "combo-title",
      key: "Enter",
      timeoutMs: 12_000,
    });

    expect(refLocator).toHaveBeenCalledWith(page, "combo-title");
    expect(locator.press).toHaveBeenCalledWith("Enter", { delay: 0, timeout: 12_000 });
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it("keeps untargeted press backwards-compatible as a page keyboard action", async () => {
    await pressKeyViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      key: "Escape",
    });

    expect(page.keyboard.press).toHaveBeenCalledWith("Escape", { delay: 0 });
    expect(refLocator).not.toHaveBeenCalled();
  });
});
