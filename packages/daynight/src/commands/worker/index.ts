import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { canonicalId } from "../../api/parse.js";
import { parseVersionArgument } from "../../api/json.js";
import type { WorkerControlRequest } from "./control.js";
import type { WorkerRepositoryCommandRequest } from "./configuration-guide.js";
import { workerDefinition } from "./definition.js";

export type WorkerCommandDependencies = {
  setup: (context: CliContext) => Promise<void>;
  attach: (options: { homeDirectory: string }) => Promise<void>;
  migrateWorkspaces: (options: { homeDirectory: string; rollback: boolean; log: (message: string) => void }) => Promise<void>;
  prepareRepositories: (context: CliContext, signal?: AbortSignal) => Promise<void>;
  repository: (request: WorkerRepositoryCommandRequest, context: CliContext) => Promise<void>;
  run: (options: { homeDirectory: string; packageDirectory: string; log?: (message: string) => void; signal?: AbortSignal; prepareRepositories?: (signal: AbortSignal) => Promise<void> }) => Promise<void>;
  manage: (options: { homeDirectory: string; packageDirectory: string; request: WorkerControlRequest; log?: (message: string) => void; signal?: AbortSignal }) => Promise<void>;
};

const defaultDependencies: WorkerCommandDependencies = {
  setup: async (context) => (await import("./setup.js")).runWorkerSetup(context),
  attach: async (options) => (await import("./attach.js")).attachWorker(options),
  migrateWorkspaces: async (options) => (await import("./migration.js")).migrateWorkerWorkspaces(options),
  prepareRepositories: async (context, signal) => (await import("./configuration-guide.js")).ensureWorkerRepositories(context, undefined, signal),
  repository: async (request, context) => (await import("./configuration-guide.js")).runWorkerRepositoryCommand(request, context),
  run: async (options) => (await import("./runtime.js")).runWorker(options),
  manage: async (options) => (await import("./runtime.js")).runWorkerControl(options),
};

export const runWorkerCommand = async (args: readonly string[], context: CliContext, dependencies: WorkerCommandDependencies = defaultDependencies): Promise<void> => {
  const command = parseCommand(workerDefinition, args, ["daynight", "worker"], "daynight worker --help");
  if (command.kind !== "run") {
    context.stdout(renderCommandHelp(command.command, command.path));
    return;
  }
  if (command.command.name === "setup") {
    await dependencies.setup(context);
    return;
  }
  if (command.command.name === "attach") {
    await dependencies.attach({ homeDirectory: context.homeDirectory() });
    return;
  }
  if (command.command.name === "migrate-workspaces") {
    await dependencies.migrateWorkspaces({ homeDirectory: context.homeDirectory(), rollback: command.options.has("--rollback"), log: (message) => { context.stderr(message); } });
    return;
  }
  const runtime = () => ({ homeDirectory: context.homeDirectory(), packageDirectory: context.packageDirectory, log: (message: string) => { context.stderr(message); } });
  if (command.command.name === "run") {
    await dependencies.run({ ...runtime(), prepareRepositories: (signal) => dependencies.prepareRepositories(context, signal) });
    return;
  }
  const help = `${command.path.join(" ")} --help`;
  const uuid = (value: string, label: string): string => {
    const parsed = canonicalId(value);
    if (parsed === null) throw new UsageError(`${label} must be a hyphenated UUID.`, help);
    return parsed;
  };
  const option = (name: string): string => command.options.get(name) as string;
  const rawProject = command.options.get("--project") as string | undefined;
  if (command.path.at(-2) === "repo") {
    const request: WorkerRepositoryCommandRequest = command.command.name === "list"
      ? { kind: "list", json: command.options.has("--json") }
      : { kind: command.command.name as "add" | "remove", ...(rawProject === undefined ? {} : { projectId: uuid(rawProject, "Project ID") }) };
    await dependencies.repository(request, context);
    return;
  }
  const original = { taskId: uuid(command.values[0]!, "Task ID"), claimId: uuid(option("--claim-id"), "Claim ID"), ...(rawProject === undefined ? {} : { projectId: uuid(rawProject, "Project ID") }) };
  let request: WorkerControlRequest;
  if (command.command.name === "retry") request = { ...original, kind: "retry" };
  else {
    let version: bigint;
    try { version = parseVersionArgument(option("--if-version")); }
    catch (cause) { throw new UsageError(cause instanceof Error ? cause.message : String(cause), help); }
    request = { ...original, kind: command.command.name as "release" | "resume", version };
  }
  await dependencies.manage({ ...runtime(), request });
};
