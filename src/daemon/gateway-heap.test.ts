// Managed Gateway heap tests cover adaptive sizing across host sizes.
import { describe, expect, it } from "vitest";
import { resolveGatewayHeapNodeOptions } from "./gateway-heap.js";

const MIB = 1024 * 1024;

describe("resolveGatewayHeapNodeOptions", () => {
  it("prefers constrained memory", () => {
    expect(
      resolveGatewayHeapNodeOptions({
        constrainedMemoryBytes: 12_288 * MIB,
        physicalMemoryBytes: 64_000 * MIB,
      }),
    ).toBe("--max-old-space-size=6144");
  });

  it("caps large hosts at 8 GiB", () => {
    expect(
      resolveGatewayHeapNodeOptions({
        constrainedMemoryBytes: 0,
        physicalMemoryBytes: 64_000 * MIB,
      }),
    ).toBe("--max-old-space-size=8192");
  });

  it("uses half of ordinary host memory", () => {
    expect(
      resolveGatewayHeapNodeOptions({
        constrainedMemoryBytes: 0,
        physicalMemoryBytes: 8192 * MIB,
      }),
    ).toBe("--max-old-space-size=4096");
  });

  it("retains native headroom on smaller hosts", () => {
    expect(
      resolveGatewayHeapNodeOptions({
        constrainedMemoryBytes: 2048 * MIB,
        physicalMemoryBytes: 8192 * MIB,
      }),
    ).toBe("--max-old-space-size=1536");
  });
});
