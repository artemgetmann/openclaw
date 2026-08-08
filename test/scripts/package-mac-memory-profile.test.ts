import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const packageScript = fs.readFileSync(path.join(root, "scripts", "package-mac-app.sh"), "utf8");

describe("macOS package memory profile", () => {
  it("offers a validated SwiftPM job cap without changing the default scheduler", () => {
    expect(packageScript).toContain('SWIFT_BUILD_JOBS="${SWIFT_BUILD_JOBS:-}"');
    expect(packageScript).toContain("^([1-9]|[1-5][0-9]|6[0-4])$");
    expect(packageScript).toContain('SWIFT_BUILD_JOB_ARGS=(--jobs "$SWIFT_BUILD_JOBS")');
    expect(packageScript).toContain("SWIFT_BUILD_JOBS must be an integer from 1 through 64");
    expect(packageScript.match(/swift build "\$\{SWIFT_BUILD_JOB_ARGS\[@\]\}"/g)).toHaveLength(2);
  });
});
