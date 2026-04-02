import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHostChromeUserDataDir } from "./chrome-host-paths.js";

describe("resolveHostChromeUserDataDir", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers the real account home over a cleanroom HOME override on macOS", () => {
    vi.spyOn(os, "homedir").mockReturnValue(
      "/Users/user/Library/Application Support/OpenClaw Consumer/cleanroom-home",
    );
    vi.spyOn(os, "userInfo").mockReturnValue({
      username: "user",
      uid: 501,
      gid: 20,
      shell: "/bin/zsh",
      homedir: "/Users/user",
    });

    expect(resolveHostChromeUserDataDir("darwin")).toBe(
      "/Users/user/Library/Application Support/Google/Chrome",
    );
  });
});
