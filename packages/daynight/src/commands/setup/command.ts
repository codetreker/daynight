import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { configure } from "../../config/setup.js";
import { setupDefinition } from "./definition.js";

export const runSetupCommand = async (args: readonly string[], context: CliContext): Promise<void> => {
  if (args.some((argument) => /^--server-token(?:=|$)/.test(argument) || argument.startsWith("--server-token-stdin="))) throw new UsageError("Pass automation tokens through --server-token-stdin; token values are not accepted as command arguments.", "daynight setup --help");
  const tokenFlag = args.indexOf("--server-token-stdin");
  if (tokenFlag !== -1 && args[tokenFlag + 1] !== undefined && !args[tokenFlag + 1]!.startsWith("-")) throw new UsageError("--server-token-stdin is a boolean flag and takes no argument.", "daynight setup --help");
  const command = parseCommand(setupDefinition, args, ["daynight", "setup"], "daynight setup --help");
  if (command.kind !== "run") { context.stdout(renderCommandHelp(command.command, command.path)); return; }
  const serverUrl = command.options.get("--server-url") as string | undefined;
  const serverTokenStdin = command.options.has("--server-token-stdin");
  const remote = command.options.get("--review-repo") as string | undefined;
  const repositoryPath = command.options.get("--review-path") as string | undefined;
  if (repositoryPath !== undefined && remote === undefined) throw new UsageError("--review-path requires --review-repo.", "daynight setup --help");
  await configure(context, serverUrl === undefined && remote === undefined && !serverTokenStdin ? undefined : {
    ...(serverUrl === undefined ? {} : { serverUrl }),
    ...(serverTokenStdin ? { serverTokenStdin: true } : {}),
    ...(remote === undefined ? {} : { reviewRepository: { remote, ...(repositoryPath === undefined ? {} : { path: repositoryPath }) } }),
  });
};
