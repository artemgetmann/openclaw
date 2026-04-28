import { formatCliCommand } from "../cli/command-format.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../daemon/constants.js";
import { formatRuntimeStatus } from "../daemon/runtime-format.js";
import { buildPlatformRuntimeLogHints } from "../daemon/runtime-hints.js";
import { resolveGatewayRuntimeIdentityEnv } from "../daemon/service-env.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import {
  isSystemdUnavailableDetail,
  renderSystemdUnavailableHints,
} from "../daemon/systemd-hints.js";
import { isWSLEnv } from "../infra/wsl.js";
import { getResolvedLoggerSettings } from "../logging.js";

type RuntimeHintOptions = {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
};

export function formatGatewayRuntimeSummary(
  runtime: GatewayServiceRuntime | undefined,
): string | null {
  return formatRuntimeStatus(runtime);
}

export function buildGatewayRuntimeHints(
  runtime: GatewayServiceRuntime | undefined,
  options: RuntimeHintOptions = {},
): string[] {
  const hints: string[] = [];
  if (!runtime) {
    return hints;
  }
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const daemonEnv = resolveGatewayRuntimeIdentityEnv(env);
  const fileLog = (() => {
    try {
      return getResolvedLoggerSettings().file;
    } catch {
      return null;
    }
  })();
  if (platform === "linux" && isSystemdUnavailableDetail(runtime.detail)) {
    hints.push(...renderSystemdUnavailableHints({ wsl: isWSLEnv() }));
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    return hints;
  }
  if (runtime.cachedLabel && platform === "darwin") {
    // Consumer lanes should print the normalized daemon identity so the
    // bootout/install hint matches the actual LaunchAgent label in use.
    const label =
      daemonEnv.OPENCLAW_LAUNCHD_LABEL?.trim() ||
      resolveGatewayLaunchAgentLabel(daemonEnv.OPENCLAW_PROFILE);
    hints.push(
      `LaunchAgent label cached but plist missing. Clear with: launchctl bootout gui/$UID/${label}`,
    );
    hints.push(`Then reinstall: ${formatCliCommand("openclaw gateway install", daemonEnv)}`);
  }
  if (runtime.missingUnit) {
    hints.push(
      `Service not installed. Run: ${formatCliCommand("openclaw gateway install", daemonEnv)}`,
    );
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    return hints;
  }
  if (runtime.status === "stopped") {
    hints.push("Service is loaded but not running (likely exited immediately).");
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    hints.push(
      ...buildPlatformRuntimeLogHints({
        platform,
        env: daemonEnv,
        systemdServiceName: resolveGatewaySystemdServiceName(daemonEnv.OPENCLAW_PROFILE),
        windowsTaskName: resolveGatewayWindowsTaskName(daemonEnv.OPENCLAW_PROFILE),
      }),
    );
  }
  return hints;
}
