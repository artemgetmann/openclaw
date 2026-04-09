import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { resolveUserTimezone } from "./date-time.js";

describe("resolveUserTimezone", () => {
  it("returns explicit IANA timezones unchanged", () => {
    expect(resolveUserTimezone("Asia/Dubai")).toBe("Asia/Dubai");
  });

  it("treats local as an explicit follow-host sentinel", () => {
    withEnv({ TZ: "Asia/Makassar" }, () => {
      expect(resolveUserTimezone("local")).toBe("Asia/Makassar");
    });
  });

  it("treats host as an explicit follow-host sentinel", () => {
    withEnv({ TZ: "Asia/Makassar" }, () => {
      expect(resolveUserTimezone("host")).toBe("Asia/Makassar");
    });
  });

  it("falls back to host timezone when unset", () => {
    withEnv({ TZ: "Asia/Makassar" }, () => {
      expect(resolveUserTimezone(undefined)).toBe("Asia/Makassar");
    });
  });

  it("falls back to host timezone when configured timezone is invalid", () => {
    withEnv({ TZ: "Asia/Makassar" }, () => {
      expect(resolveUserTimezone("Mars/Olympus")).toBe("Asia/Makassar");
    });
  });
});
