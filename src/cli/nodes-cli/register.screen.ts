import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import { recordScreenFromNode } from "../screen-record.js";
import { runNodesCommand } from "./cli-utils.js";
import { nodesCallOpts } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

export function registerNodesScreenCommands(nodes: Command) {
  const screen = nodes
    .command("screen")
    .description("Capture screen recordings from a paired node");

  nodesCallOpts(
    screen
      .command("record")
      .description("Capture a short screen recording from a node (prints MEDIA:<path>)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--screen <index>", "Screen index (0 = primary)", "0")
      .option("--app <name>", "Record the best visible window owned by this app name")
      .option("--bundle <id>", "Record the best visible window owned by this bundle id")
      .option("--window-id <id>", "Record a specific CoreGraphics window id")
      .option("--duration <ms|10s>", "Clip duration (ms or 10s)", "10000")
      .option("--fps <fps>", "Frames per second", "10")
      .option("--no-audio", "Disable microphone audio capture")
      .option("--out <path>", "Output path")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 120000)", "120000")
      .action(async (opts: NodesRpcOpts & { out?: string }) => {
        await runNodesCommand("screen record", async () => {
          const { path, payload } = await recordScreenFromNode(
            { ...opts, audio: opts.audio !== false },
            {
              requireTarget: false,
              requireDisplayReason: false,
            },
          );

          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify(
                {
                  file: {
                    path,
                    durationMs: payload.durationMs,
                    fps: payload.fps,
                    screenIndex: payload.screenIndex,
                    appName: payload.appName,
                    bundleId: payload.bundleId,
                    windowId: payload.windowId,
                    hasAudio: payload.hasAudio,
                  },
                },
                null,
                2,
              ),
            );
            return;
          }
          defaultRuntime.log(`MEDIA:${shortenHomePath(path)}`);
        });
      }),
    { timeoutMs: 180_000 },
  );
}
