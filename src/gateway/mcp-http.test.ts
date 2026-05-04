import { afterEach, describe, expect, it } from "vitest";
import {
  closeMcpLoopbackServer,
  getActiveMcpLoopbackRuntime,
  startMcpLoopbackServer,
} from "./mcp-http.js";

describe("MCP loopback HTTP transport", () => {
  afterEach(async () => {
    await closeMcpLoopbackServer();
  });

  it("holds authenticated streamable HTTP GET requests as an SSE channel", async () => {
    const server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();
    expect(runtime?.port).toBe(server.port);
    expect(runtime?.ownerToken).toBeTruthy();

    const abort = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${runtime?.ownerToken ?? ""}`,
        },
        signal: abort.signal,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const reader = response.body?.getReader();
      expect(reader).toBeTruthy();
      const firstChunk = await reader?.read();
      const text = new TextDecoder().decode(firstChunk?.value);
      expect(text).toContain("openclaw mcp loopback ready");
    } finally {
      abort.abort();
    }
  });
});
