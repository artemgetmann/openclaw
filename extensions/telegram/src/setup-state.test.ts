import { describe, expect, it } from "vitest";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { telegramSetupPlugin } from "./channel.setup.js";
import {
  resolveTelegramAccountSetupStatus,
  resolveTelegramAccountSetupUnconfiguredReason,
  verifyTelegramSetupAccount,
} from "./setup-state.js";

const telegramSetupAdapter = buildChannelSetupWizardAdapterFromSetupWizard({
  plugin: telegramSetupPlugin,
  wizard: telegramSetupPlugin.setupWizard!,
});

function createCfg() {
  return {
    channels: {
      telegram: {
        enabled: true,
        accounts: {
          alerts: {
            botToken: "shared-token", // pragma: allowlist secret
          },
          work: {
            botToken: "shared-token", // pragma: allowlist secret
          },
        },
      },
    },
  } as const;
}

describe("telegram setup-state", () => {
  it("marks duplicate token accounts as unconfigured with a shared reason", () => {
    const cfg = createCfg();

    const verification = verifyTelegramSetupAccount({
      cfg,
      accountId: "work",
    });

    expect(verification.configured).toBe(false);
    expect(verification.duplicateTokenOwnerAccountId).toBe("alerts");
    expect(
      resolveTelegramAccountSetupUnconfiguredReason({
        cfg,
        accountId: "work",
      }),
    ).toContain('account "alerts"');
    expect(
      resolveTelegramAccountSetupStatus({
        cfg,
        accountId: "work",
      }),
    ).toMatchObject({
      status: "blocked",
      credentialConfigured: true,
      ready: false,
      blocked: true,
    });
  });

  it("distinguishes configured credentials from ready accounts", () => {
    const cfg = {
      secrets: {
        defaults: {
          env: "exec-provider",
        },
        providers: {
          "exec-provider": {
            source: "exec",
            command: "/usr/bin/env",
          },
        },
      },
      channels: {
        telegram: {
          enabled: true,
          accounts: {
            work: {
              botToken: "${TELEGRAM_WORK_TOKEN}",
            },
          },
        },
      },
    } as const;

    expect(
      resolveTelegramAccountSetupStatus({
        cfg,
        accountId: "work",
      }),
    ).toMatchObject({
      status: "configured",
      credentialConfigured: true,
      ready: false,
      blocked: false,
      blockedReason: null,
    });
  });

  it("keeps channel setup status configured when one account still owns the token", async () => {
    const status = await telegramSetupAdapter.getStatus({
      cfg: createCfg(),
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
  });

  it("applies duplicate-token verification to the setup-only plugin account view", () => {
    const cfg = createCfg();
    const workAccount = telegramSetupPlugin.config.resolveAccount(cfg, "work");

    expect(telegramSetupPlugin.config.isConfigured?.(workAccount, cfg)).toBe(false);
    expect(telegramSetupPlugin.config.unconfiguredReason?.(workAccount, cfg)).toContain(
      'account "alerts"',
    );
  });

  it("marks a unique token account as ready", () => {
    const cfg = {
      channels: {
        telegram: {
          enabled: true,
          accounts: {
            ops: {
              botToken: "token-ops",
            },
          },
        },
      },
    } as const;

    expect(
      resolveTelegramAccountSetupStatus({
        cfg,
        accountId: "ops",
      }),
    ).toMatchObject({
      status: "ready",
      credentialConfigured: true,
      ready: true,
      blocked: false,
    });
  });
});
