import { spawn, spawnSync } from "node:child_process";
import fssync from "node:fs";
import path from "node:path";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";

export const GATEWAY_LIFECYCLE_TEMPORARY_UNAVAILABLE_EXIT_CODE = 75;

export type GatewayLifecycleLeaseResult =
  | { outcome: "held" }
  | { outcome: "reexecuted"; exitCode: number };

type GatewayLifecycleLeaseDeps = {
  platform: NodeJS.Platform;
  argv: string[];
  execArgv: string[];
  execPath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  moduleUrl: string;
  fileExists: (filePath: string) => boolean;
  spawnSync: typeof spawnSync;
  spawn: typeof spawn;
};

function defaultDeps(): GatewayLifecycleLeaseDeps {
  return {
    platform: process.platform,
    argv: process.argv,
    execArgv: process.execArgv,
    execPath: process.execPath,
    env: process.env,
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
    fileExists: fssync.existsSync,
    spawnSync,
    spawn,
  };
}

export type GatewayLifecycleLeasePaths = {
  root: string;
  wrapper: string;
  helper: string;
  runner: string;
  commandHelper: string;
};

export function resolveGatewayLifecycleLeasePaths(
  deps: Pick<
    GatewayLifecycleLeaseDeps,
    "argv" | "cwd" | "moduleUrl" | "fileExists"
  > = defaultDeps(),
): GatewayLifecycleLeasePaths | null {
  const root = resolveOpenClawPackageRootSync({
    cwd: deps.cwd,
    argv1: deps.argv[1],
    moduleUrl: deps.moduleUrl,
  });
  if (!root) {
    return null;
  }

  const paths = {
    root,
    wrapper: path.join(root, "scripts", "with-heavy-local-slot.sh"),
    helper: path.join(root, "scripts", "lib", "heavy-local-slot.sh"),
    runner: path.join(root, "scripts", "lib", "heavy-local-slot-runner.pl"),
    commandHelper: path.join(root, "scripts", "gateway-lifecycle-command.sh"),
  };
  return deps.fileExists(paths.wrapper) &&
    deps.fileExists(paths.helper) &&
    deps.fileExists(paths.runner) &&
    deps.fileExists(paths.commandHelper)
    ? paths
    : null;
}

function inheritedMachineLeaseIsValid(
  paths: GatewayLifecycleLeasePaths,
  deps: Pick<GatewayLifecycleLeaseDeps, "env" | "spawnSync">,
): boolean {
  // The shell helper validates the capability token against live owner
  // metadata and proves this process tree descends from that exact PID/start
  // identity. Checking only an environment flag would let a sibling Codex
  // process forge admission.
  const result = deps.spawnSync(
    "/bin/bash",
    [
      "-c",
      'source "$1"; openclaw_heavy_local_slot_inherited_lease_is_valid gateway-lifecycle',
      "openclaw-gateway-lifecycle-lease-check",
      paths.helper,
    ],
    {
      env: deps.env,
      stdio: "ignore",
    },
  );
  return result.status === 0;
}

function waitForChildExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    child.once("error", () => {
      resolve(GATEWAY_LIFECYCLE_TEMPORARY_UNAVAILABLE_EXIT_CODE);
    });
    child.once("exit", (code, signal) => {
      // A missing numeric status or signal termination is not proof that the
      // guarded transaction completed. Preserve the temporary-unavailable
      // contract instead of collapsing an ambiguous wrapper failure to 1.
      resolve(signal || code === null ? GATEWAY_LIFECYCLE_TEMPORARY_UNAVAILABLE_EXIT_CODE : code);
    });
  });
}

/**
 * Ensures the complete `openclaw gateway restart` command runs beneath the
 * stable machine-wide lease before any lifecycle mutation occurs.
 *
 * The first process is only an admission shim. When it does not already belong
 * to the live lease owner, it re-runs the exact CLI argv through the canonical
 * wrapper and returns that child's status. The guarded child proves ancestry
 * and executes the real restart body exactly once. Node execution flags are
 * intentionally not replayed: the canonical helper requires the package
 * entrypoint to be the first Node argument, excluding eval/preload bypasses.
 */
export async function ensureGatewayLifecycleLease(
  overrides: Partial<GatewayLifecycleLeaseDeps> = {},
): Promise<GatewayLifecycleLeaseResult> {
  const deps = { ...defaultDeps(), ...overrides };
  if (deps.platform !== "darwin") {
    return { outcome: "held" };
  }

  const paths = resolveGatewayLifecycleLeasePaths(deps);
  if (!paths) {
    process.stderr.write(
      "Gateway restart temporarily unavailable: packaged lifecycle lease helpers are missing.\n",
    );
    return {
      outcome: "reexecuted",
      exitCode: GATEWAY_LIFECYCLE_TEMPORARY_UNAVAILABLE_EXIT_CODE,
    };
  }
  if (inheritedMachineLeaseIsValid(paths, deps)) {
    return { outcome: "held" };
  }

  const label = `gateway-restart:${deps.env.OPENCLAW_LAUNCHD_LABEL?.trim() || "default"}`;
  try {
    const child = deps.spawn(
      paths.wrapper,
      [
        "--policy",
        "gateway-lifecycle",
        "--label",
        label,
        "--",
        paths.commandHelper,
        "cli",
        "--",
        deps.execPath,
        ...deps.argv.slice(1),
      ],
      {
        cwd: deps.cwd,
        env: deps.env,
        stdio: "inherit",
      },
    );
    return { outcome: "reexecuted", exitCode: await waitForChildExit(child) };
  } catch {
    return {
      outcome: "reexecuted",
      exitCode: GATEWAY_LIFECYCLE_TEMPORARY_UNAVAILABLE_EXIT_CODE,
    };
  }
}

/**
 * Admit the shared restart runner by re-executing only the canonical gateway
 * restart command. Programmatic callers such as `openclaw update` must not
 * re-run their entire parent command merely to serialize its final restart.
 */
export async function ensureGatewayLifecycleLeaseForRestart(
  opts: { json?: boolean } = {},
  overrides: Partial<GatewayLifecycleLeaseDeps> = {},
): Promise<GatewayLifecycleLeaseResult> {
  const deps = { ...defaultDeps(), ...overrides };
  if (deps.platform !== "darwin") {
    return { outcome: "held" };
  }

  const paths = resolveGatewayLifecycleLeasePaths(deps);
  if (!paths) {
    process.stderr.write(
      "Gateway restart temporarily unavailable: packaged lifecycle lease helpers are missing.\n",
    );
    return {
      outcome: "reexecuted",
      exitCode: GATEWAY_LIFECYCLE_TEMPORARY_UNAVAILABLE_EXIT_CODE,
    };
  }

  // Prefer the source/package launcher because it is the stable entrypoint in
  // both development checkouts and packaged runtimes. Keep dist as the narrow
  // fallback already accepted by the shell validator.
  const sourceEntrypoint = path.join(paths.root, "openclaw.mjs");
  const distEntrypoint = path.join(paths.root, "dist", "index.js");
  const entrypoint = deps.fileExists(sourceEntrypoint) ? sourceEntrypoint : distEntrypoint;
  return await ensureGatewayLifecycleLease({
    ...deps,
    argv: [deps.execPath, entrypoint, "gateway", "restart", ...(opts.json ? ["--json"] : [])],
  });
}
