import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("scripts/package-consumer-mac-app-fast.sh", () => {
  const script = fs.readFileSync(
    path.join(root, "scripts", "package-consumer-mac-app-fast.sh"),
    "utf8",
  );

  it("forces a JS build when a fast package would otherwise ship without CLI runtime output", () => {
    expect(script).toContain("runtime_js_ready()");
    expect(script).toContain('[[ -f "$ROOT_DIR/dist/index.js" || -f "$ROOT_DIR/dist/index.mjs" ]]');
    expect(script).toContain('[[ -f "$ROOT_DIR/dist/entry.js" || -f "$ROOT_DIR/dist/entry.mjs" ]]');
    expect(script).toContain('if [[ "$REUSE_RUNTIME" != "1" ]] && ! runtime_js_ready');
    expect(script).toContain("runtime JS missing; forcing JS build once");
    expect(script).toContain('SKIP_TSC="$DEFAULT_SKIP_TSC"');
  });

  it("refuses runtime reuse when the reusable runtime entrypoints are missing", () => {
    expect(script).toContain('if [[ "$REUSE_RUNTIME" == "1" ]] && ! runtime_js_ready');
    expect(script).toContain("runtime JS missing; --reuse-runtime is unsafe");
    expect(script).toContain("Rerun once without --reuse-runtime");
  });
});
