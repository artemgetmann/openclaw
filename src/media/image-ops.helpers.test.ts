import { describe, expect, it } from "vitest";
import {
  buildImageResizeSideGrid,
  IMAGE_REDUCE_QUALITY_STEPS,
  optimizeImageToPng,
} from "./image-ops.js";

describe("buildImageResizeSideGrid", () => {
  it("returns descending unique sides capped by maxSide", () => {
    expect(buildImageResizeSideGrid(1200, 900)).toEqual([1200, 1000, 900, 800]);
  });

  it("keeps only positive side values", () => {
    expect(buildImageResizeSideGrid(0, 0)).toEqual([]);
  });
});

describe("IMAGE_REDUCE_QUALITY_STEPS", () => {
  it("keeps expected quality ladder", () => {
    expect([...IMAGE_REDUCE_QUALITY_STEPS]).toEqual([85, 75, 65, 55, 45, 35]);
  });
});

describe("optimizeImageToPng", () => {
  it("preserves the real backend failure in the final error", async () => {
    try {
      await optimizeImageToPng(Buffer.from("not an image"), 1);
      throw new Error("expected optimizeImageToPng to fail");
    } catch (err) {
      expect(err).toMatchObject({ cause: expect.any(Error) });
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Failed to optimize PNG image: /);
    }
  });
});
