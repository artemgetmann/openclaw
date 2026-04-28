import { pathToFileURL } from "node:url";
import {
  inferConsumerRuntimeIdFromCheckout,
  normalizeConsumerRuntimeId,
  resolveConsumerRuntimeIdentity,
} from "../src/consumer/runtime-identity.js";

type Command = "default-id" | "field" | "json" | "normalize";

function main(argv: string[]): void {
  const [command, ...rest] = argv as [Command | undefined, ...string[]];
  switch (command) {
    case "normalize": {
      process.stdout.write(normalizeConsumerRuntimeId(rest[0] ?? ""));
      return;
    }
    case "default-id": {
      const args = parseArgs(rest);
      requireFlag(args.rootDir, "--root");
      process.stdout.write(
        inferConsumerRuntimeIdFromCheckout({
          rootDir: args.rootDir,
        }),
      );
      return;
    }
    case "field": {
      const args = parseArgs(rest);
      requireFlag(args.field, "--field");
      const identity = resolveConsumerRuntimeIdentity({
        homeDir: args.homeDir,
        instanceId: args.instanceId,
      });
      const value = identity[args.field];
      if (value === undefined) {
        throw new Error(`unknown consumer runtime identity field: ${args.field}`);
      }
      process.stdout.write(String(value));
      return;
    }
    case "json": {
      const args = parseArgs(rest);
      const identity = resolveConsumerRuntimeIdentity({
        homeDir: args.homeDir,
        instanceId: args.instanceId,
      });
      process.stdout.write(`${JSON.stringify(identity)}\n`);
      return;
    }
    default:
      throw new Error(
        "Usage: node --import tsx scripts/consumer-runtime-identity.ts <normalize|default-id|field|json> [--instance <id>] [--home <dir>] [--root <dir>] [--field <name>]",
      );
  }
}

function parseArgs(argv: string[]): {
  field?: string;
  homeDir?: string;
  instanceId?: string;
  rootDir?: string;
} {
  const parsed: {
    field?: string;
    homeDir?: string;
    instanceId?: string;
    rootDir?: string;
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    switch (token) {
      case "--field":
        parsed.field = value ?? "";
        index += 1;
        break;
      case "--home":
        parsed.homeDir = value ?? "";
        index += 1;
        break;
      case "--instance":
        parsed.instanceId = value ?? "";
        index += 1;
        break;
      case "--root":
        parsed.rootDir = value ?? "";
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }

  return parsed;
}

function requireFlag(value: string | undefined, flag: string): asserts value is string {
  if (!value) {
    throw new Error(`${flag} is required`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
