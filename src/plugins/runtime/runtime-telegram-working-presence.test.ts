import { describe, expect, it, vi } from "vitest";
import { createTelegramWorkingPresenceManager } from "./runtime-telegram-working-presence.js";

describe("telegram working presence", () => {
  it("coalesces concurrent owners, refreshes, and stops after the last owner", async () => {
    const lease = { refresh: vi.fn(async () => undefined), stop: vi.fn() };
    const startTyping = vi.fn(async () => lease);
    const manager = createTelegramWorkingPresenceManager({ startTyping });
    const route = { to: "-1001", accountId: "jarvis", messageThreadId: 42 };

    await manager.start({ ownerId: "worker-a", ...route });
    await manager.start({ ownerId: "worker-b", ...route });
    await manager.start({ ownerId: "worker-a", ...route });

    expect(startTyping).toHaveBeenCalledTimes(1);
    expect(lease.refresh).toHaveBeenCalledTimes(2);
    manager.stop("worker-a");
    await Promise.resolve();
    expect(lease.stop).not.toHaveBeenCalled();
    manager.stop("worker-b");
    await Promise.resolve();
    expect(lease.stop).toHaveBeenCalledTimes(1);
    manager.stop("worker-b");
    expect(lease.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps topics isolated and transfers a reused owner without orphan leases", async () => {
    const leases = [
      { refresh: vi.fn(async () => undefined), stop: vi.fn() },
      { refresh: vi.fn(async () => undefined), stop: vi.fn() },
    ];
    const startTyping = vi.fn(async () => leases[startTyping.mock.calls.length - 1]);
    const manager = createTelegramWorkingPresenceManager({ startTyping });

    await manager.start({ ownerId: "worker", to: "-1001", messageThreadId: 1 });
    await manager.start({ ownerId: "worker", to: "-1001", messageThreadId: 2 });

    expect(leases[0].stop).toHaveBeenCalledTimes(1);
    manager.stopAll();
    await Promise.resolve();
    expect(leases[1].stop).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent starts and honors cleanup while creation is pending", async () => {
    const lease = { refresh: vi.fn(async () => undefined), stop: vi.fn() };
    let resolveLease!: (value: typeof lease) => void;
    const startTyping = vi.fn(
      async () => await new Promise<typeof lease>((resolve) => (resolveLease = resolve)),
    );
    const manager = createTelegramWorkingPresenceManager({ startTyping });
    const route = { to: "-1001", messageThreadId: 42 };

    const startA = manager.start({ ownerId: "a", ...route });
    const startB = manager.start({ ownerId: "b", ...route });
    manager.stop("a");
    manager.stop("b");
    resolveLease(lease);
    await Promise.all([startA, startB]);

    expect(startTyping).toHaveBeenCalledTimes(1);
    expect(lease.stop).toHaveBeenCalledTimes(1);
  });

  it("preserves a shared pending lease when the first owner stops", async () => {
    const lease = { refresh: vi.fn(async () => undefined), stop: vi.fn() };
    let resolveLease!: (value: typeof lease) => void;
    const startTyping = vi.fn(
      async () => await new Promise<typeof lease>((resolve) => (resolveLease = resolve)),
    );
    const manager = createTelegramWorkingPresenceManager({ startTyping });
    const route = { to: "-1001", messageThreadId: 42 };

    const first = manager.start({ ownerId: "worker-a", ...route });
    const second = manager.start({ ownerId: "worker-b", ...route });
    manager.stop("worker-a");
    resolveLease(lease);
    await Promise.all([first, second]);

    expect(startTyping).toHaveBeenCalledTimes(1);
    expect(lease.stop).not.toHaveBeenCalled();
    manager.stop("worker-b");
    await Promise.resolve();
    expect(lease.stop).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect an owner stopped while a shared refresh is pending", async () => {
    let resolveRefresh!: () => void;
    const lease = {
      refresh: vi.fn(async () => await new Promise<void>((resolve) => (resolveRefresh = resolve))),
      stop: vi.fn(),
    };
    const manager = createTelegramWorkingPresenceManager({
      startTyping: vi.fn(async () => lease),
    });
    const route = { to: "-1001", messageThreadId: 42 };

    await manager.start({ ownerId: "worker-a", ...route });
    const startB = manager.start({ ownerId: "worker-b", ...route });
    await vi.waitFor(() => expect(lease.refresh).toHaveBeenCalledTimes(1));
    manager.stop("worker-b");
    resolveRefresh();
    await startB;

    manager.stop("worker-a");
    await vi.waitFor(() => expect(lease.stop).toHaveBeenCalledTimes(1));
  });

  it("keeps an active shared owner when its best-effort refresh fails", async () => {
    const lease = {
      refresh: vi.fn(async () => {
        throw new Error("telegram unavailable");
      }),
      stop: vi.fn(),
    };
    const manager = createTelegramWorkingPresenceManager({
      startTyping: vi.fn(async () => lease),
    });
    const route = { to: "-1001", messageThreadId: 42 };

    await manager.start({ ownerId: "worker-a", ...route });
    await expect(manager.start({ ownerId: "worker-b", ...route })).rejects.toThrow(
      "telegram unavailable",
    );
    manager.stop("worker-a");
    await Promise.resolve();
    expect(lease.stop).not.toHaveBeenCalled();

    manager.stop("worker-b");
    await vi.waitFor(() => expect(lease.stop).toHaveBeenCalledTimes(1));
  });

  it.each(["owner stop", "gateway stop"])(
    "consumes pending provider rejection during %s cleanup",
    async (cleanup) => {
      let rejectLease!: (error: Error) => void;
      const startTyping = vi.fn(
        async () =>
          await new Promise<never>((_resolve, reject) => {
            rejectLease = reject;
          }),
      );
      const manager = createTelegramWorkingPresenceManager({ startTyping });
      const start = manager.start({ ownerId: "worker", to: "-1001", messageThreadId: 42 });

      await vi.waitFor(() => expect(startTyping).toHaveBeenCalledTimes(1));
      if (cleanup === "owner stop") {
        manager.stop("worker");
      } else {
        manager.stopAll();
      }
      rejectLease(new Error("telegram unavailable"));

      await expect(start).rejects.toThrow("telegram unavailable");
      await Promise.resolve();
    },
  );
});
