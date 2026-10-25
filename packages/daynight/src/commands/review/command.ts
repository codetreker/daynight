import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import { reviewDefinition } from "./definition.js";
import type { ReviewConfiguration } from "./config.js";
import { resolveReviewPaths } from "./paths.js";
import type { ReviewPaths } from "./paths.js";
import type { AddRepositoryInput, AddRepositoryOptions, AddRepositoryResult } from "./repositories.js";

export type ReviewCommandDependencies = {
  addRepository: (input: AddRepositoryInput, paths: ReviewPaths, options: AddRepositoryOptions) => Promise<AddRepositoryResult>;
  listReviews: (paths: ReviewPaths) => Promise<string>;
  loadConfiguration: (paths: ReviewPaths) => Promise<ReviewConfiguration>;
  runReview: (configuration: ReviewConfiguration, paths: ReviewPaths) => Promise<void>;
};

const defaultDependencies = (context: CliContext): ReviewCommandDependencies => ({
  addRepository: async (...args) => (await import("./repositories.js")).addRepository(...args),
  listReviews: async (paths) => (await import("./configuration-guide.js")).guideReviewConfiguration(context, async () => (await import("./listing.js")).listReviews(paths)),
  loadConfiguration: async (paths) => (await import("./configuration-guide.js")).guideReviewConfiguration(context, async () => (await import("./config.js")).loadConfiguration(paths)),
  runReview: async (configuration, paths) => {
    const { formatCoordinatorEvent, runForegroundReview } = await import("./runtime.js");
    await runForegroundReview(configuration, paths, {
      packageDirectory: context.packageDirectory,
      log: (event) => { context.stderr(`${formatCoordinatorEvent(event)}\n`); },
    });
  },
});

export const runReviewCommand = async (
  args: readonly string[],
  context: CliContext,
  dependencies: ReviewCommandDependencies = defaultDependencies(context),
): Promise<void> => {
  const operation = parseCommand(reviewDefinition, args, ["daynight", "review"], "daynight review --help");
  if (operation.kind !== "run") {
    context.stdout(renderCommandHelp(operation.command, operation.path));
    return;
  }
  if (operation.command.name === "add-repo" && operation.values[0]!.trim() === "") {
    throw new UsageError("add-repo requires a remote value.", "daynight review --help");
  }
  const homeDirectory = context.homeDirectory();
  const paths = resolveReviewPaths(homeDirectory);
  if (operation.command.name === "list") {
    context.stdout(await dependencies.listReviews(paths));
    return;
  }
  if (operation.command.name === "add-repo") {
    const repositoryPath = operation.options.get("--path") as string | undefined;
    const remote = operation.values[0]!;
    const input: AddRepositoryInput = repositoryPath === undefined ? { remote } : { remote, path: repositoryPath };
    const result = await dependencies.addRepository(input, paths, {
      homeDirectory,
      workingDirectory: context.workingDirectory(),
    });
    context.stdout(`Repository ${result.repository.coordinate} ${result.added ? "added" : "is already configured"}.\nPath: ${result.repository.path}\nConfiguration: ${paths.configFile}\nConfiguration takes effect the next time daynight review run starts.\n`);
    return;
  }
  const configuration = await dependencies.loadConfiguration(paths);
  await dependencies.runReview(configuration, paths);
};
