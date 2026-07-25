import { afterEach, describe, expect, it, vi } from "vitest";

const acquireSessionWriteLock = vi.hoisted(() =>
  vi.fn(async () => ({ release: async () => undefined })),
);

// Keep lock acquisition entirely in promise continuations. This makes the test
// prove the queue's explicit event-loop yield rather than incidental filesystem I/O.
vi.mock("../../agents/session-write-lock.js", () => ({ acquireSessionWriteLock }));

import { clearSessionStoreCacheForTest, withSessionStoreLockForTest } from "./store.js";

describe("session store lock queue", () => {
  afterEach(() => {
    clearSessionStoreCacheForTest();
    acquireSessionWriteLock.mockClear();
  });

  it("preserves FIFO order while yielding to immediates between queued tasks", async () => {
    const order: string[] = [];
    let resolveImmediate!: () => void;
    const immediateRan = new Promise<void>((resolve) => {
      resolveImmediate = resolve;
    });

    const tasks = Array.from({ length: 3 }, (_, index) =>
      withSessionStoreLockForTest("/tmp/session-store-lock-queue.json", async () => {
        order.push(`task-${index}`);
        if (index === 0) {
          setImmediate(() => {
            order.push("immediate");
            resolveImmediate();
          });
        }
      }),
    );

    await Promise.all([...tasks, immediateRan]);
    expect(order).toEqual(["task-0", "immediate", "task-1", "task-2"]);
  });

  it("still yields after a failed queued task", async () => {
    const order: string[] = [];
    let resolveImmediate!: () => void;
    const immediateRan = new Promise<void>((resolve) => {
      resolveImmediate = resolve;
    });

    const failed = withSessionStoreLockForTest(
      "/tmp/session-store-lock-queue-failure.json",
      async () => {
        order.push("failed-task");
        setImmediate(() => {
          order.push("immediate");
          resolveImmediate();
        });
        throw new Error("expected failure");
      },
    );
    const succeeded = withSessionStoreLockForTest(
      "/tmp/session-store-lock-queue-failure.json",
      async () => {
        order.push("successful-task");
      },
    );

    const [failedResult, succeededResult] = await Promise.all([
      failed.then(
        () => "unexpected success",
        () => "expected failure",
      ),
      succeeded.then(() => "success"),
      immediateRan,
    ]);
    expect(failedResult).toBe("expected failure");
    expect(succeededResult).toBe("success");
    expect(order).toEqual(["failed-task", "immediate", "successful-task"]);
  });
});
