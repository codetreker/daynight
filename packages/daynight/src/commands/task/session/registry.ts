import type { CliContext } from "../../../cli/context.js";
import { UsageError } from "../../../cli/context.js";
import type { CommandDefinition, ParsedCommand } from "../../../cli/schema.js";
import type { TaskCommandDependencies } from "../command.js";

export type TaskSessionCommand = Extract<ParsedCommand, { readonly kind: "run" }>;
export type TaskSessionCommandModule = {
  readonly definitions: readonly CommandDefinition[];
  readonly run: (command: TaskSessionCommand, context: CliContext, dependencies: TaskCommandDependencies) => Promise<void>;
};

// Read and send modules register their own command definitions and handlers here.
// Empty registration does not advertise commands the installed client cannot run.
export const taskSessionModules: readonly TaskSessionCommandModule[] = [];
const definitions = taskSessionModules.flatMap(module => module.definitions);
export const taskSessionDefinitions: readonly CommandDefinition[] = definitions.length === 0 ? [] : [{
  name: "session", description: "Inspect and interact with a specific Task Session", commands: definitions,
  options: [{ names: ["-h", "--help"], description: "Show this help", action: "help" }],
}];
export const runTaskSessionCommand = async (command: TaskSessionCommand, context: CliContext, dependencies: TaskCommandDependencies): Promise<void> => {
  const module = taskSessionModules.find(module => module.definitions.some(definition => definition.name === command.path[3]));
  if (module === undefined) throw new UsageError("This Task Session command is unavailable.", "daynight task --help");
  await module.run(command, context, dependencies);
};
