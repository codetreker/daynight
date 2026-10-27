import type { CliContext } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { workerDefinition } from "./definition.js";

export type WorkerCommandDependencies = {
  run: (options: { homeDirectory: string; packageDirectory: string; log?: (message: string) => void; signal?: AbortSignal }) => Promise<void>;
};

const defaultDependencies: WorkerCommandDependencies = {
  run: async (options) => (await import("./runtime.js")).runWorker(options),
};

export const runWorkerCommand = async (args: readonly string[], context: CliContext, dependencies: WorkerCommandDependencies = defaultDependencies): Promise<void> => {
  const command = parseCommand(workerDefinition, args, ["daynight", "worker"], "daynight worker --help");
  if (command.kind !== "run") {
    context.stdout(renderCommandHelp(command.command, command.path));
    return;
  }
  await dependencies.run({ homeDirectory: context.homeDirectory(), packageDirectory: context.packageDirectory, log: (message) => { context.stderr(message); } });
};
