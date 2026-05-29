import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type MockLocator = {
  click: ReturnType<typeof vi.fn>;
  count?: ReturnType<typeof vi.fn>;
  evaluate?: ReturnType<typeof vi.fn>;
  filter?: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  first?: ReturnType<typeof vi.fn>;
  innerText?: ReturnType<typeof vi.fn>;
  isVisible?: ReturnType<typeof vi.fn>;
  locator?: ReturnType<typeof vi.fn>;
  nth?: ReturnType<typeof vi.fn>;
  press?: ReturnType<typeof vi.fn>;
  waitFor?: ReturnType<typeof vi.fn>;
};

let page: {
  getByRole: ReturnType<typeof vi.fn>;
  keyboard: { press: ReturnType<typeof vi.fn> };
  locator: ReturnType<typeof vi.fn>;
  waitForTimeout: ReturnType<typeof vi.fn>;
};
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
let chooseOptionViaPlaywright: typeof import("./pw-tools-core.interactions.js").chooseOptionViaPlaywright;

describe("combobox-style interactions", () => {
  beforeAll(async () => {
    ({ chooseOptionViaPlaywright, fillFormViaPlaywright, pressKeyViaPlaywright } =
      await import("./pw-tools-core.interactions.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    locator = null;
    page = {
      getByRole: vi.fn(() => ({
        first: vi.fn(() => ({
          waitFor: vi.fn(async () => {
            throw new Error("role option not available");
          }),
        })),
      })),
      keyboard: { press: vi.fn(async () => {}) },
      locator: vi.fn(() => ({
        first: vi.fn(() => ({
          fill: vi.fn(async () => {}),
        })),
      })),
      waitForTimeout: vi.fn(async () => {}),
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

  it("chooses a portal option when the snapshot ref points at a combobox wrapper", async () => {
    const searchInput = { fill: vi.fn(async () => {}) };
    const descendant = {
      first: vi.fn(() => searchInput),
    };
    locator = {
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {
        throw new Error("element is not an editable element");
      }),
      innerText: vi
        .fn(async () => "To")
        .mockResolvedValueOnce("To")
        .mockResolvedValueOnce("To Bali/Denpasar (DPS)"),
      locator: vi.fn(() => descendant),
    };

    const staleOption = {
      click: vi.fn(async () => {}),
      evaluate: vi.fn(async () => false),
      innerText: vi.fn(async () => "Kuala Lumpur (KUL)"),
      isVisible: vi.fn(async () => true),
    };
    const matchingOption = {
      click: vi.fn(async () => {}),
      evaluate: vi.fn(async () => false),
      innerText: vi.fn(async () => "Bali/Denpasar (DPS)"),
      isVisible: vi.fn(async () => true),
    };
    const candidates = {
      count: vi.fn(async () => 2),
      first: vi.fn(() => ({ waitFor: vi.fn(async () => {}) })),
      nth: vi.fn((index: number) => (index === 0 ? staleOption : matchingOption)),
    };
    const portalOptions = {
      filter: vi.fn(() => candidates),
    };
    page.locator = vi.fn((selector: string) => {
      if (selector.includes('[role="option"]')) {
        return portalOptions;
      }
      return {
        first: vi.fn(() => ({
          fill: vi.fn(async () => {}),
        })),
      };
    }) as never;

    const result = await chooseOptionViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      ref: "combo-to",
      optionText: "Bali/Denpasar (DPS)",
    });

    expect(refLocator).toHaveBeenCalledWith(page, "combo-to");
    expect(locator.click).toHaveBeenCalledWith({ timeout: 8000 });
    expect(searchInput.fill).toHaveBeenCalledWith("Bali/Denpasar (DPS)", { timeout: 8000 });
    expect(portalOptions.filter).toHaveBeenCalledWith({ hasText: "Bali/Denpasar (DPS)" });
    expect(staleOption.click).not.toHaveBeenCalled();
    expect(matchingOption.click).toHaveBeenCalledWith({ timeout: 8000 });
    expect(result).toMatchObject({
      optionText: "Bali/Denpasar (DPS)",
      matchedText: "Bali/Denpasar (DPS)",
      selectedText: "To Bali/Denpasar (DPS)",
      changed: true,
    });
  });

  it("supports contains matching for dynamic portal option labels", async () => {
    locator = {
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {
        throw new Error("wrapper fill failed");
      }),
      innerText: vi.fn(async () => "Nationality"),
      locator: vi.fn(() => ({
        first: vi.fn(() => ({
          fill: vi.fn(async () => {}),
        })),
      })),
    };
    const matchingOption = {
      click: vi.fn(async () => {}),
      evaluate: vi.fn(async () => false),
      innerText: vi.fn(async () => "Indonesia - ID"),
      isVisible: vi.fn(async () => true),
    };
    const candidates = {
      count: vi.fn(async () => 1),
      first: vi.fn(() => ({ waitFor: vi.fn(async () => {}) })),
      nth: vi.fn(() => matchingOption),
    };
    page.locator = vi.fn(() => ({
      filter: vi.fn(() => candidates),
    })) as never;

    await chooseOptionViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      ref: "nationality",
      optionText: "Indonesia",
      match: "contains",
    });

    expect(matchingOption.click).toHaveBeenCalledWith({ timeout: 8000 });
  });
});
