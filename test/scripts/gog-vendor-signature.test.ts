import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
// GitHub's Windows runners expose Git Bash through PATH rather than /bin/bash.
const bashBin = process.platform === "win32" ? "bash" : "/bin/bash";

describe("packaged Gog signing identity", () => {
  it("fails closed unless the preserved vendor signature has the reviewed identity", () => {
    const output = execFileSync(
      bashBin,
      [path.join(root, "scripts", "test-gog-vendor-signature.sh")],
      { encoding: "utf8" },
    );

    expect(output.trim()).toBe("Gog vendor signature tests passed");
  });

  it("packages signed architecture slices instead of creating a re-signed universal binary", () => {
    const packageScript = fs.readFileSync(path.join(root, "scripts", "package-mac-app.sh"), "utf8");
    const codesignScript = fs.readFileSync(
      path.join(root, "scripts", "codesign-mac-app.sh"),
      "utf8",
    );
    const gogRuntimeScript = fs.readFileSync(
      path.join(root, "scripts", "lib", "consumer-gog-runtime.sh"),
      "utf8",
    );

    expect(packageScript).toContain("gog/darwin-arm64/gog");
    expect(packageScript).toContain("gog/darwin-x86_64/gog");
    expect(gogRuntimeScript).not.toContain('/usr/bin/lipo -create "${thin_bins[@]}"');
    expect(gogRuntimeScript).toContain('openclaw_verify_vendor_signed_gog "$packaged_bin"');
    expect(codesignScript).toContain("Preserving verified Gog vendor signature");
    expect(codesignScript).toContain(
      'openclaw_runtime_payload_is_vendor_signed_gog "$runtime_file"',
    );
  });
});
