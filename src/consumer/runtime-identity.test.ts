import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inferConsumerRuntimeIdFromCheckout,
  normalizeConsumerRuntimeId,
  resolveConsumerRuntimeIdentity,
} from "./runtime-identity.js";

describe("consumer/runtime-identity", () => {
  it("normalizes instance ids to the shared shell-safe contract", () => {
    expect(normalizeConsumerRuntimeId("  Main Durable_Lane  ")).toBe("main-durable-lane");
    expect(normalizeConsumerRuntimeId("___")).toBe("");
    expect(normalizeConsumerRuntimeId("Already-clean")).toBe("already-clean");
  });

  it("infers a default instance id only for linked worktree checkouts", () => {
    expect(
      inferConsumerRuntimeIdFromCheckout({
        rootDir: "/tmp/openclaw/.worktrees/Main Consumer Lane",
        absoluteGitDir: "/tmp/openclaw/.git/worktrees/main-consumer-lane",
      }),
    ).toBe("main-consumer-lane");

    expect(
      inferConsumerRuntimeIdFromCheckout({
        rootDir: "/tmp/openclaw",
        absoluteGitDir: "/tmp/openclaw/.git",
      }),
    ).toBe("");
  });

  it("builds the shared consumer runtime identity when no instance is set", () => {
    const homeDir = "/Users/tester";
    expect(resolveConsumerRuntimeIdentity({ homeDir })).toEqual({
      normalizedId: "",
      runtimeRoot: "/Users/tester/Library/Application Support/OpenClaw",
      stateDir: "/Users/tester/Library/Application Support/OpenClaw/.openclaw",
      configPath: "/Users/tester/Library/Application Support/OpenClaw/.openclaw/openclaw.json",
      workspacePath: "/Users/tester/Library/Application Support/OpenClaw/.openclaw/workspace",
      logDir: "/Users/tester/Library/Application Support/OpenClaw/.openclaw/logs",
      profile: "consumer",
      launchdLabel: "ai.openclaw.consumer",
      gatewayLaunchdLabel: "ai.openclaw.gateway",
      defaultsPrefix: "openclaw.consumer",
      gatewayPort: 18789,
      gatewayBind: "loopback",
    });
  });

  it("builds an isolated consumer runtime identity for an instance id", () => {
    const identity = resolveConsumerRuntimeIdentity({
      homeDir: "/Users/tester",
      instanceId: "Main Durable Lane",
    });

    expect(identity).toEqual({
      normalizedId: "main-durable-lane",
      runtimeRoot: "/Users/tester/Library/Application Support/OpenClaw/instances/main-durable-lane",
      stateDir:
        "/Users/tester/Library/Application Support/OpenClaw/instances/main-durable-lane/.openclaw",
      configPath:
        "/Users/tester/Library/Application Support/OpenClaw/instances/main-durable-lane/.openclaw/openclaw.json",
      workspacePath:
        "/Users/tester/Library/Application Support/OpenClaw/instances/main-durable-lane/.openclaw/workspace",
      logDir:
        "/Users/tester/Library/Application Support/OpenClaw/instances/main-durable-lane/.openclaw/logs",
      profile: "consumer-main-durable-lane",
      launchdLabel: "ai.openclaw.consumer.main-durable-lane",
      gatewayLaunchdLabel: "ai.openclaw.consumer.main-durable-lane.gateway",
      defaultsPrefix: "openclaw.consumer.instances.main-durable-lane",
      gatewayPort: 28587,
      gatewayBind: "loopback",
    });
  });

  it("uses the current home directory by default", () => {
    const identity = resolveConsumerRuntimeIdentity({ instanceId: "lane" });
    expect(identity.runtimeRoot).toBe(
      path.join(os.homedir(), "Library", "Application Support", "OpenClaw", "instances", "lane"),
    );
  });
});
