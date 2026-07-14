import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHooksHandler } from "../gateway/server-http.test-harness.js";
import { dispatchMonitorEventToCron } from "../gateway/server-methods/monitor.js";
import { createMonitorRecord, saveMonitorStore } from "../monitor/store.js";
import { observeBrowserReplyOnce } from "./reply-monitor.js";

type TestHttpServer = { close: () => Promise<void>; url: string };

async function listen(server: http.Server): Promise<TestHttpServer> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const servers: TestHttpServer[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true })));
});

describe("browser reply observer isolated HTTP smoke", () => {
  it("reads one fake local page through the browser client and posts one hash-only wake", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-smoke-"));
    tempRoots.push(root);
    const cronStorePath = path.join(root, "cron.json");
    const monitorStorePath = path.join(root, "monitors.json");
    const enqueueRun = vi.fn(async (jobId: string, mode: "due" | "force" = "due") => ({
      ok: true as const,
      enqueued: true as const,
      runId: `smoke:${jobId}:${mode}`,
    }));
    await saveMonitorStore(monitorStorePath, {
      version: 1,
      monitors: [
        createMonitorRecord(
          {
            monitorId: "monitor-browser-smoke",
            agentId: "main",
            originSessionKey: "agent:main:telegram:direct:1",
            monitorSessionKey: "agent:main:monitor:monitor-browser-smoke",
            sourceType: "browser",
            sourceTarget: { profile: "smoke-profile", targetId: "tab-smoke" },
            cadence: { kind: "every", everyMs: 300_000 },
            trigger: {
              kind: "browser_observer",
              match: {
                sourceType: "browser",
                matchKeys: ["profile", "targetId"],
                eventTypes: ["dom.text.matched"],
              },
            },
            cronJobId: "cron-browser-smoke",
          },
          1_720_000_000_000,
        ),
      ],
    });

    const routedEvents: unknown[] = [];
    const hookHandler = createHooksHandler({
      dispatchMonitorEventHook: async (event) => {
        routedEvents.push(event);
        return await dispatchMonitorEventToCron({
          cronStorePath,
          cron: { enqueueRun },
          event,
          monitorId: event.monitorId,
        });
      },
    });
    const hookServer = await listen(
      http.createServer((req, res) => {
        void hookHandler(req, res);
      }),
    );
    servers.push(hookServer);

    const html = '<main><div data-test="reply">Replied: local smoke</div></main>';
    const browserServer = await listen(
      http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        if (req.url?.startsWith("/tabs")) {
          res.end(
            JSON.stringify({
              running: true,
              tabs: [
                {
                  targetId: "tab-smoke",
                  title: "Local fixture",
                  type: "page",
                  url: "http://fixture.test/thread/7",
                },
              ],
            }),
          );
          return;
        }
        if (req.url?.startsWith("/act")) {
          const text = /data-test="reply">([^<]+)/.exec(html)?.[1] ?? "";
          res.end(
            JSON.stringify({
              ok: true,
              targetId: "tab-smoke",
              url: "http://fixture.test/thread/7",
              result: {
                allowed: true,
                found: true,
                text,
                url: "http://fixture.test/thread/7",
              },
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      }),
    );
    servers.push(browserServer);

    const result = await observeBrowserReplyOnce({
      browserBaseUrl: browserServer.url,
      cursorStorePath: path.join(root, "cursor.json"),
      hookUrl: `${hookServer.url}/hooks/monitor-event`,
      hookToken: "hook-secret",
      matchMode: "contains",
      matchValue: "Replied:",
      monitorId: "monitor-browser-smoke",
      profile: "smoke-profile",
      selector: "[data-test=reply]",
      targetId: "tab-smoke",
      urlPattern: "http://fixture.test/thread/*",
    });

    expect(result).toMatchObject({ dispatched: true, matched: true, stateChanged: true });
    expect(enqueueRun).toHaveBeenCalledWith("cron-browser-smoke", "force");
    expect(routedEvents).toHaveLength(1);
    expect(JSON.stringify(routedEvents[0])).not.toContain("local smoke");
    expect(routedEvents[0]).toMatchObject({
      triggerKind: "browser_observer",
      sourceType: "browser",
      sourceTarget: { profile: "smoke-profile", targetId: "tab-smoke" },
      eventType: "dom.text.matched",
    });
  });
});
