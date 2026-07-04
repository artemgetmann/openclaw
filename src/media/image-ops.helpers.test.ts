import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  buildImageResizeSideGrid,
  IMAGE_REDUCE_QUALITY_STEPS,
  optimizeImageToPng,
  prefersSips,
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

describe("prefersSips", () => {
  it("uses sips for packaged Jarvis paths even when the launch env is missing", () => {
    const result = withEnv(
      {
        OPENCLAW_IMAGE_BACKEND: undefined,
        OPENCLAW_HOME: "/Users/nataliiagetman/Library/Application Support/Jarvis",
      },
      () => prefersSips(),
    );

    expect(result).toBe(process.platform === "darwin");
  });

  it("keeps sharp as an explicit opt-in override", () => {
    const result = withEnv(
      {
        OPENCLAW_IMAGE_BACKEND: " sharp ",
        OPENCLAW_HOME: "/Users/nataliiagetman/Library/Application Support/Jarvis",
      },
      () => prefersSips(),
    );

    expect(result).toBe(false);
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
