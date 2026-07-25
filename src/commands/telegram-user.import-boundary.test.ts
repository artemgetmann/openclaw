import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("telegram-user command import boundary", () => {
  it("keeps monitor and wait infrastructure out of one-shot command startup", () => {
    const source = fs.readFileSync(new URL("./telegram-user.ts", import.meta.url), "utf8");
    const eagerRuntimeImports = new Set(
      [...source.matchAll(/^import(?! type)[\s\S]*?from "([^"]+)";$/gm)].map((match) => match[1]),
    );
    const deferredModules = [
      "../monitor/listener-health.js",
      "../telegram-user/monitor-event.js",
      "../telegram-user/monitor-hook-url.js",
      "../telegram-user/monitor-listener.js",
      "../telegram-user/wait.js",
    ];

    for (const modulePath of deferredModules) {
      const escapedModulePath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(eagerRuntimeImports.has(modulePath), modulePath).toBe(false);
      expect(source).toMatch(new RegExp(`import\\(\\s*"${escapedModulePath}"\\s*\\)`));
    }
  });
});
