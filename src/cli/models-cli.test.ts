import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";

const modelsStatusCommand = vi.fn().mockResolvedValue(undefined);
const noopAsync = vi.fn(async () => undefined);
const modelsAuthAddCommand = vi.fn().mockResolvedValue(undefined);
const modelsAuthLoginCommand = vi.fn().mockResolvedValue(undefined);
const modelsAuthPasteTokenCommand = vi.fn().mockResolvedValue(undefined);
const modelsAuthSetupTokenCommand = vi.fn().mockResolvedValue(undefined);

vi.mock("../commands/models.js", () => ({
  modelsStatusCommand,
  modelsAliasesAddCommand: noopAsync,
  modelsAliasesListCommand: noopAsync,
  modelsAliasesRemoveCommand: noopAsync,
  modelsAuthAddCommand,
  modelsAuthLoginCommand,
  modelsAuthOrderClearCommand: noopAsync,
  modelsAuthOrderGetCommand: noopAsync,
  modelsAuthOrderSetCommand: noopAsync,
  modelsAuthPasteTokenCommand,
  modelsAuthSetupTokenCommand,
  modelsFallbacksAddCommand: noopAsync,
  modelsFallbacksClearCommand: noopAsync,
  modelsFallbacksListCommand: noopAsync,
  modelsFallbacksRemoveCommand: noopAsync,
  modelsImageFallbacksAddCommand: noopAsync,
  modelsImageFallbacksClearCommand: noopAsync,
  modelsImageFallbacksListCommand: noopAsync,
  modelsImageFallbacksRemoveCommand: noopAsync,
  modelsListCommand: noopAsync,
  modelsScanCommand: noopAsync,
  modelsSetCommand: noopAsync,
  modelsSetImageCommand: noopAsync,
}));

describe("models cli", () => {
  let registerModelsCli: (typeof import("./models-cli.js"))["registerModelsCli"];

  beforeAll(async () => {
    // Load once; vi.mock above ensures command handlers are already mocked.
    ({ registerModelsCli } = await import("./models-cli.js"));
  });

  beforeEach(() => {
    modelsAuthAddCommand.mockClear();
    modelsAuthLoginCommand.mockClear();
    modelsAuthPasteTokenCommand.mockClear();
    modelsAuthSetupTokenCommand.mockClear();
    modelsStatusCommand.mockClear();
  });

  function createProgram() {
    const program = new Command();
    registerModelsCli(program);
    return program;
  }

  async function runModelsCommand(args: string[]) {
    await runRegisteredCli({
      register: registerModelsCli as (program: Command) => void,
      argv: args,
    });
  }

  it("registers github-copilot login command", async () => {
    const program = createProgram();
    const models = program.commands.find((cmd) => cmd.name() === "models");
    expect(models).toBeTruthy();

    const auth = models?.commands.find((cmd) => cmd.name() === "auth");
    expect(auth).toBeTruthy();

    const login = auth?.commands.find((cmd) => cmd.name() === "login-github-copilot");
    expect(login).toBeTruthy();

    await program.parseAsync(
      ["models", "auth", "--agent", "poe", "login-github-copilot", "--yes"],
      { from: "user" },
    );

    expect(modelsAuthLoginCommand).toHaveBeenCalledTimes(1);
    expect(modelsAuthLoginCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        method: "device",
        yes: true,
        agent: "poe",
      }),
      expect.any(Object),
    );
  });

  it.each([
    {
      label: "add",
      args: ["models", "auth", "--agent", "poe", "add"],
      command: modelsAuthAddCommand,
      expected: { agent: "poe" },
    },
    {
      label: "login",
      args: ["models", "auth", "--agent", "poe", "login", "--provider", "openai-codex"],
      command: modelsAuthLoginCommand,
      expected: { agent: "poe", provider: "openai-codex" },
    },
    {
      label: "setup-token",
      args: ["models", "auth", "--agent", "poe", "setup-token", "--provider", "anthropic"],
      command: modelsAuthSetupTokenCommand,
      expected: { agent: "poe", provider: "anthropic" },
    },
    {
      label: "paste-token",
      args: ["models", "auth", "--agent", "poe", "paste-token", "--provider", "anthropic"],
      command: modelsAuthPasteTokenCommand,
      expected: { agent: "poe", provider: "anthropic" },
    },
    {
      label: "login-github-copilot",
      args: ["models", "auth", "--agent", "poe", "login-github-copilot", "--yes"],
      command: modelsAuthLoginCommand,
      expected: { agent: "poe", provider: "github-copilot", method: "device", yes: true },
    },
  ])("passes parent --agent to models auth $label", async ({ args, command, expected }) => {
    await runModelsCommand(args);

    expect(command).toHaveBeenCalledWith(expect.objectContaining(expected), expect.any(Object));
  });

  it.each([
    { label: "status flag", args: ["models", "status", "--agent", "poe"] },
    { label: "parent flag", args: ["models", "--agent", "poe", "status"] },
  ])("passes --agent to models status ($label)", async ({ args }) => {
    await runModelsCommand(args);
    expect(modelsStatusCommand).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "poe" }),
      expect.any(Object),
    );
  });

  it("shows help for models auth without error exit", async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
    registerModelsCli(program);

    try {
      await program.parseAsync(["models", "auth"], { from: "user" });
      expect.fail("expected help to exit");
    } catch (err) {
      const error = err as { exitCode?: number };
      expect(error.exitCode).toBe(0);
    }
  });
});
