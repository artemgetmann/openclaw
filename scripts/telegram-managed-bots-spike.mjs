#!/usr/bin/env node

const DEFAULT_POLL_TIMEOUT_SECONDS = 180;
const DEFAULT_BOT_NAME = "Jarvis Managed Test";
const BOT_API_BASE_URL = "https://api.telegram.org";

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    const key = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    const nextValue = inlineValue ?? argv[i + 1];

    if (key === "--manager-bot-username") {
      args.managerBotUsername = nextValue;
    } else if (key === "--suggested-bot-username") {
      args.suggestedBotUsername = nextValue;
    } else if (key === "--suggested-bot-name") {
      args.suggestedBotName = nextValue;
    } else if (key === "--poll-timeout-seconds") {
      args.pollTimeoutSeconds = nextValue;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }

    if (inlineValue === undefined) {
      i += 1;
    }
  }

  return args;
}

function usage() {
  return [
    "Usage: node scripts/telegram-managed-bots-spike.mjs [--dry-run]",
    "",
    "Environment:",
    "  TELEGRAM_MANAGER_BOT_TOKEN  Required for live API calls.",
    "  MANAGER_BOT_USERNAME        Required to build the Telegram approval link.",
    "  SUGGESTED_BOT_USERNAME      Optional. Defaults to JarvisManagedTest<suffix>Bot.",
    '  SUGGESTED_BOT_NAME          Optional. Defaults to "Jarvis Managed Test".',
    "  POLL_TIMEOUT_SECONDS        Optional. Defaults to 180.",
    "  DRY_RUN=1                   Print the plan without network calls or token requirements.",
  ].join("\n");
}

function envOrArg(argValue, envName) {
  return argValue || process.env[envName] || "";
}

function normalizeManagerUsername(username) {
  return username.trim().replace(/^@/, "");
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 7);
}

function defaultSuggestedBotUsername() {
  // Bot usernames must end with "bot". Put the random part before that suffix so
  // the default stays valid while avoiding collisions in repeated proof runs.
  return `JarvisManagedTest${randomSuffix()}Bot`;
}

function isValidTelegramBotUsername(username) {
  return /^[A-Za-z][A-Za-z0-9_]{3,30}[Bb][Oo][Tt]$/.test(username);
}

function buildCreationLink({ managerBotUsername, suggestedBotUsername, suggestedBotName }) {
  const manager = encodeURIComponent(normalizeManagerUsername(managerBotUsername));
  const suggestedBot = encodeURIComponent(suggestedBotUsername.trim());
  const name = encodeURIComponent(suggestedBotName.trim());
  return `https://t.me/newbot/${manager}/${suggestedBot}?name=${name}`;
}

function redactToken(token) {
  if (!token) {
    return "<missing>";
  }

  const [botId] = token.split(":", 1);
  if (!botId || botId === token) {
    return "<redacted-token>";
  }

  return `${botId}:<redacted>`;
}

function redactString(value, tokens) {
  let redacted = String(value);
  for (const token of tokens.filter(Boolean)) {
    redacted = redacted.split(token).join(redactToken(token));
  }
  return redacted;
}

function redactJson(value, tokens) {
  return redactString(JSON.stringify(value), tokens);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asPositiveInteger(value, fallback, label) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

async function telegramApi({ token, method, body, knownTokens }) {
  const url = `${BOT_API_BASE_URL}/bot${token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `${method} returned non-JSON response: ${redactString(error.message, knownTokens)}`,
      { cause: error },
    );
  }

  if (!payload?.ok) {
    throw new Error(`${method} failed: ${redactJson(payload, knownTokens)}`);
  }

  return payload.result;
}

function findManagedBotUpdate(updates, suggestedBotUsername) {
  const target = suggestedBotUsername.toLowerCase();

  for (const update of updates) {
    const managedBot = update?.managed_bot;
    const username = managedBot?.bot?.username;
    if (typeof username === "string" && username.toLowerCase() === target) {
      return {
        updateId: update.update_id,
        user: managedBot.user,
        bot: managedBot.bot,
      };
    }
  }

  return null;
}

async function pollForManagedBot({ managerToken, suggestedBotUsername, pollTimeoutSeconds }) {
  const deadline = Date.now() + pollTimeoutSeconds * 1000;
  let offset;

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1000, deadline - Date.now());
    const timeout = Math.min(30, Math.ceil(remainingMs / 1000));
    const updates = await telegramApi({
      token: managerToken,
      method: "getUpdates",
      body: {
        ...(offset === undefined ? {} : { offset }),
        timeout,
        allowed_updates: ["managed_bot"],
      },
      knownTokens: [managerToken],
    });

    if (!Array.isArray(updates)) {
      throw new Error("getUpdates returned an unexpected non-array result.");
    }

    for (const update of updates) {
      if (Number.isInteger(update?.update_id)) {
        offset = Math.max(offset ?? 0, update.update_id + 1);
      }
    }

    const matchedUpdate = findManagedBotUpdate(updates, suggestedBotUsername);
    if (matchedUpdate) {
      return matchedUpdate;
    }

    if (updates.length === 0) {
      await sleep(500);
    }
  }

  throw new Error(
    `Timed out after ${pollTimeoutSeconds}s waiting for managed_bot update for @${suggestedBotUsername}.`,
  );
}

function assertUserId(bot) {
  // Telegram's current Bot API names the managed-bot identifier parameter
  // `user_id`. Do not substitute `bot_id` or `managed_bot_id`; failing here is
  // safer than calling a token method with a guessed parameter.
  if (!Number.isInteger(bot?.id)) {
    throw new Error(
      "ManagedBotUpdated.bot.id is missing; cannot safely call getManagedBotToken(user_id).",
    );
  }

  return bot.id;
}

function printPlan({ creationLink, dryRun, pollTimeoutSeconds, suggestedBotUsername }) {
  console.log(`${dryRun ? "DRY RUN" : "LIVE"} Telegram Managed Bots spike`);
  console.log(`Creation link: ${creationLink}`);
  console.log("Planned steps:");
  console.log("  1. Verify manager bot identity with getMe.");
  console.log("  2. Artem approves the Telegram newbot link above.");
  console.log(
    `  3. Poll getUpdates for allowed_updates=["managed_bot"] up to ${pollTimeoutSeconds}s.`,
  );
  console.log(`  4. Match ManagedBotUpdated for @${suggestedBotUsername}.`);
  console.log("  5. Fetch the managed token using getManagedBotToken(user_id).");
  console.log("  6. Verify the managed token with getMe.");
  console.log("  7. Restrict access with setManagedBotAccessSettings(user_id, true).");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const dryRun = args.dryRun || process.env.DRY_RUN === "1";
  const managerToken = process.env.TELEGRAM_MANAGER_BOT_TOKEN || "";
  const managerBotUsernameInput = normalizeManagerUsername(
    envOrArg(args.managerBotUsername, "MANAGER_BOT_USERNAME"),
  );
  const managerBotUsername = managerBotUsernameInput || (dryRun ? "ManagerBotUsername" : "");
  const suggestedBotUsername =
    envOrArg(args.suggestedBotUsername, "SUGGESTED_BOT_USERNAME").trim() ||
    defaultSuggestedBotUsername();
  const suggestedBotName =
    envOrArg(args.suggestedBotName, "SUGGESTED_BOT_NAME").trim() || DEFAULT_BOT_NAME;
  const pollTimeoutSeconds = asPositiveInteger(
    envOrArg(args.pollTimeoutSeconds, "POLL_TIMEOUT_SECONDS"),
    DEFAULT_POLL_TIMEOUT_SECONDS,
    "POLL_TIMEOUT_SECONDS",
  );

  if (!managerBotUsername) {
    throw new Error("MANAGER_BOT_USERNAME is required to build the approval link.");
  }
  if (!isValidTelegramBotUsername(suggestedBotUsername)) {
    throw new Error(
      `SUGGESTED_BOT_USERNAME must be a valid Telegram bot username ending in "bot": ${suggestedBotUsername}`,
    );
  }

  const creationLink = buildCreationLink({
    managerBotUsername,
    suggestedBotUsername,
    suggestedBotName,
  });

  if (dryRun) {
    printPlan({ creationLink, dryRun, pollTimeoutSeconds, suggestedBotUsername });
    console.log(`Redaction check: ${redactToken("123456789:dry_run_secret_value")}`);
    console.log("PASS: dry-run completed without network calls or token requirements.");
    return;
  }

  if (!managerToken) {
    throw new Error("TELEGRAM_MANAGER_BOT_TOKEN is required unless DRY_RUN=1 or --dry-run is set.");
  }

  printPlan({ creationLink, dryRun, pollTimeoutSeconds, suggestedBotUsername });
  console.log(`Manager token: ${redactToken(managerToken)}`);

  const managerMe = await telegramApi({
    token: managerToken,
    method: "getMe",
    knownTokens: [managerToken],
  });
  console.log(`Manager getMe: id=${managerMe.id} username=@${managerMe.username ?? "<unknown>"}`);

  if (Object.prototype.hasOwnProperty.call(managerMe, "can_manage_bots")) {
    if (managerMe.can_manage_bots !== true) {
      throw new Error("Manager getMe returned can_manage_bots=false; stop before approval flow.");
    }
    console.log("Manager can_manage_bots=true.");
  } else {
    console.log(
      "Manager getMe did not include can_manage_bots; continuing because field is optional.",
    );
  }

  console.log("Waiting for Artem to approve the newbot link in Telegram...");
  const managedUpdate = await pollForManagedBot({
    managerToken,
    suggestedBotUsername,
    pollTimeoutSeconds,
  });
  const managedUserId = assertUserId(managedUpdate.bot);
  console.log(
    `Managed bot update: user_id=${managedUserId} username=@${managedUpdate.bot.username}`,
  );

  const childToken = await telegramApi({
    token: managerToken,
    method: "getManagedBotToken",
    body: { user_id: managedUserId },
    knownTokens: [managerToken],
  });

  if (typeof childToken !== "string" || !childToken.includes(":")) {
    throw new Error("getManagedBotToken returned an unexpected token shape.");
  }
  console.log(`Managed token fetched: ${redactToken(childToken)}`);

  const childMe = await telegramApi({
    token: childToken,
    method: "getMe",
    knownTokens: [managerToken, childToken],
  });
  console.log(`Managed getMe: id=${childMe.id} username=@${childMe.username ?? "<unknown>"}`);

  const restricted = await telegramApi({
    token: managerToken,
    method: "setManagedBotAccessSettings",
    body: {
      user_id: managedUserId,
      is_access_restricted: true,
    },
    knownTokens: [managerToken, childToken],
  });
  if (restricted !== true) {
    throw new Error("setManagedBotAccessSettings returned a non-true result.");
  }

  console.log("PASS: managed bot token verified and access restricted.");
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
