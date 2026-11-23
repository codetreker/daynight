import type { CliContext } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { botDefinition } from "./definition.js";

/** Keep help and argument selection independent of server and local recovery resources. */
export const runBotCommand = async (args: readonly string[], context: CliContext): Promise<void> => {
  const command = parseCommand(botDefinition, args, ["daynight", "bot"], "daynight bot --help");
  if (command.kind !== "run") { context.stdout(renderCommandHelp(command.command, command.path)); return; }
  await (await import("./commands.js")).runBotCommand(args, context);
};
