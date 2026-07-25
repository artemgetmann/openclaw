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
});
