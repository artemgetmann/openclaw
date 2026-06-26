import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let page: Record<string, unknown> | null = null;
let locator: Record<string, unknown> | null = null;

const getPageForTargetId = vi.fn(async () => {
  if (!page) {
    throw new Error("test: page not set");
  }
  return page;
});
const ensurePageState = vi.fn(() => ({}));
const restoreRoleRefsForTarget = vi.fn(() => {});
const refLocator = vi.fn(() => {
  if (!locator) {
    throw new Error("test: locator not set");
  }
  return locator;
});
const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});

vi.mock("./pw-session.js", () => {
  return {
    ensurePageState,
    forceDisconnectPlaywrightForTarget,
    getPageForTargetId,
    refLocator,
    restoreRoleRefsForTarget,
  };
});

vi.mock("./paths.js", () => {
  return {
    DEFAULT_UPLOAD_DIR: "/tmp/openclaw/uploads",
    resolveStrictExistingPathsWithinRoot: vi.fn(),
  };
});

let pasteViaPlaywright: typeof import("./pw-tools-core.interactions.js").pasteViaPlaywright;
let typeViaPlaywright: typeof import("./pw-tools-core.interactions.js").typeViaPlaywright;

function seedEditablePage(): {
  click: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  insertText: ReturnType<typeof vi.fn>;
  keyboardPress: ReturnType<typeof vi.fn>;
  locatorPress: ReturnType<typeof vi.fn>;
  locatorType: ReturnType<typeof vi.fn>;
} {
  const click = vi.fn(async () => {});
  const fill = vi.fn(async () => {});
  const keyboardPress = vi.fn(async () => {});
  const locatorPress = vi.fn(async () => {});
  const locatorType = vi.fn(async () => {});
  const insertText = vi.fn(async () => {});
  const evaluate = vi.fn(async () => true);
  locator = {
    click,
    fill,
    locator: vi.fn(() => ({ first: () => locator })),
    press: locatorPress,
    type: locatorType,
  };
  page = {
    evaluate,
    keyboard: {
      insertText,
      press: keyboardPress,
    },
    locator: vi.fn(() => ({ first: () => locator })),
  };
  return { click, evaluate, fill, insertText, keyboardPress, locatorPress, locatorType };
}

describe("rich editor repair edit", () => {
  beforeAll(async () => {
    ({ pasteViaPlaywright, typeViaPlaywright } = await import("./pw-tools-core.interactions.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    page = null;
    locator = null;
  });

  it("emits a real keyboard repair edit after paste when requested", async () => {
    const { evaluate, insertText, keyboardPress } = seedEditablePage();

    await pasteViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "composer-1",
      text: "caption plus media",
      repairEdit: true,
    });

    expect(evaluate).toHaveBeenCalledOnce();
    expect(insertText).toHaveBeenCalledWith(" ");
    expect(keyboardPress).toHaveBeenCalledWith("Backspace");
  });

  it("preserves normal paste behavior when repairEdit is omitted", async () => {
    const { insertText, keyboardPress } = seedEditablePage();

    await pasteViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "composer-1",
      text: "caption plus media",
    });

    expect(insertText).not.toHaveBeenCalled();
    expect(keyboardPress).not.toHaveBeenCalled();
  });

  it("emits a repair edit after type fill and before submit", async () => {
    const { click, fill, insertText, keyboardPress, locatorPress, locatorType } =
      seedEditablePage();

    await typeViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "composer-1",
      text: "caption plus media",
      repairEdit: true,
      submit: true,
    });

    expect(click).toHaveBeenCalledWith({ timeout: 8000 });
    expect(fill).not.toHaveBeenCalled();
    expect(keyboardPress).toHaveBeenNthCalledWith(1, "ControlOrMeta+A");
    expect(keyboardPress).toHaveBeenNthCalledWith(2, "Backspace");
    expect(locatorType).toHaveBeenCalledWith("caption plus media", { timeout: 8000, delay: 0 });
    expect(insertText).toHaveBeenCalledWith(" ");
    expect(keyboardPress).toHaveBeenNthCalledWith(3, "Backspace");
    expect(locatorPress).toHaveBeenCalledWith("Enter", { timeout: 8000 });
    expect(insertText.mock.invocationCallOrder[0]).toBeLessThan(
      locatorPress.mock.invocationCallOrder[0],
    );
  });
});
