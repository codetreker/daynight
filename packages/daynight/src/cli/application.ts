import { formatError } from "../platform/diagnostics.js";
import { commands, commandTree } from "./commands.js";
import type { CommandRegistration } from "./commands.js";
import { UsageError } from "./context.js";
import type { CliContext } from "./context.js";
import { renderCommandHelp, selectCommand } from "./schema.js";

export const runCli = async (
  args: readonly string[],
  context: CliContext,
  registry: readonly CommandRegistration[] = commands,
): Promise<number> => {
  try {
    const definition = registry === commands ? commandTree : { ...commandTree, commands: registry };
    const selection = selectCommand(definition, args);
    if (selection.kind === "help") {
      context.stdout(renderCommandHelp(definition));
      return 0;
    }
    if (selection.kind === "version") {
      context.stdout(`${context.version}\n`);
      return 0;
    }
    if (selection.kind === "skill") {
      const { runSkillRead } = await import("../commands/skill/read.js");
      await runSkillRead(selection.resource, context);
      return 0;
    }
    const registration = registry.find(({ name }) => name === selection.command.name)!;
    const command = await registration.load();
    await command.run(selection.remaining, context);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      context.stderr(`${formatError(error)} Run ${error.helpCommand} for usage.\n`);
      return 2;
    }
    context.stderr(`${formatError(error)}\n`);
    return 1;
  }
};
