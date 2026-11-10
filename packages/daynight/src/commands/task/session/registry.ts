import type { CliContext } from "../../../cli/context.js";
import { UsageError } from "../../../cli/context.js";
import type { CommandDefinition, ParsedCommand } from "../../../cli/schema.js";
import type { TaskCommandDependencies } from "../command.js";
import { taskSessionModules } from "../definition.js";

export { taskSessionModules, taskSessionDefinitions } from "../definition.js";

export type TaskSessionCommand = Extract<ParsedCommand, { readonly kind: "run" }>;
export type TaskSessionCommandModule = {
  readonly definitions: readonly CommandDefinition[];
  readonly load: () => Promise<{ readonly run: (command: TaskSessionCommand, context: CliContext, dependencies: TaskCommandDependencies) => Promise<void> }>;
};

export const runTaskSessionCommand = async (command: TaskSessionCommand, context: CliContext, dependencies: TaskCommandDependencies): Promise<void> => {
  const module = taskSessionModules.find(module => module.definitions.some(definition => definition.name === command.path[3]));
  if (module === undefined) throw new UsageError("This Task Session command is unavailable.", "daynight task --help");
  await (await module.load()).run(command, context, dependencies);
};
