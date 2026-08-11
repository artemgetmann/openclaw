import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("consumer runtime dependency deployment", () => {
  it("allows git dependency preparation tools without shipping root devDependencies", () => {
    const packageScript = fs.readFileSync(path.join(root, "scripts", "package-mac-app.sh"), "utf8");

    // npm prepares git-hosted dependencies before pnpm creates the deployment.
    // Its disposable build gets package-local dev tools, while pnpm's --prod
    // flag still controls the dependency set copied into the shipped runtime.
    expect(packageScript).toContain(
      "npm_config_include=dev \\\n" +
        '    openclaw_run_repo_pnpm "$ROOT_DIR" --filter . deploy --legacy --prod "$deploy_root"',
    );
  });

  it("ships every helper required by the gateway lifecycle lease", () => {
    const packageScript = fs.readFileSync(path.join(root, "scripts", "package-mac-app.sh"), "utf8");
    const requiredPaths = [
      "scripts/gateway-lifecycle-command.sh",
      "scripts/with-heavy-local-slot.sh",
      "scripts/lib/heavy-local-slot.sh",
      "scripts/with-shared-resource-lock.pl",
      "scripts/lib/shared-resource-lock.sh",
    ];

    // The consumer runtime is assembled outside npm pack. Each helper therefore
    // needs three independent protections: reject stale cached payloads, include
    // source changes in the cache key, and copy the file into a fresh payload.
    for (const relativePath of requiredPaths) {
      expect(packageScript).toContain(`"${relativePath}"`);
      expect(packageScript).toContain(`hash_consumer_runtime_path "${relativePath}"`);
      expect(packageScript).toContain(`"$ROOT_DIR/${relativePath}"`);
      expect(packageScript).toContain(`"$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/${relativePath}"`);
    }
    expect(packageScript).toContain("verify_required_gateway_lifecycle_tooling");
    expect(packageScript).toContain('[[ ! -x "$runtime_root/$relative_path" ]]');
    expect(
      packageScript.match(/verify_required_gateway_lifecycle_tooling "\$[A-Z_a-z0-9/]+"/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  });
});
