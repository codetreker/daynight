import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { canonicalId } from "../../api/parse.js";
import { parseVersionArgument } from "../../api/json.js";
import type { WorkerResourceCommandRequest } from "./resource-disposal.js";
import type { WorkerControlRequest } from "./control.js";
import type { WorkerRepositoryCommandRequest } from "./configuration-guide.js";
import { workerDefinition } from "./definition.js";

export type WorkerCommandDependencies = {
  resources: (options: { homeDirectory: string; request: WorkerResourceCommandRequest; output: (message: string) => void; signal?: AbortSignal }) => Promise<void>;
  setup: (context: CliContext) => Promise<void>;
  attach: (options: { homeDirectory: string }) => Promise<void>;
  repository: (request: WorkerRepositoryCommandRequest, context: CliContext) => Promise<void>;
  run: (options: { homeDirectory: string; packageDirectory: string; version: string; workingDirectory: string; log?: (message: string) => void; signal?: AbortSignal }) => Promise<void>;
  manage: (options: { homeDirectory: string; packageDirectory: string; version: string; request: WorkerControlRequest; log?: (message: string) => void; signal?: AbortSignal }) => Promise<void>;
};

const defaultDependencies: WorkerCommandDependencies = {
  resources: async options => (await import("./runtime.js")).runWorkerResources(options),
  setup: async (context) => (await import("./setup.js")).runWorkerSetup(context),
  attach: async (options) => (await import("./attach.js")).attachWorker(options),
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
  const runtime = () => ({ homeDirectory: context.homeDirectory(), packageDirectory: context.packageDirectory, log: (message: string) => { context.stderr(message); } });
  if (command.command.name === "run") {
    await dependencies.run({ ...runtime(), version: context.version, workingDirectory: context.workingDirectory() });
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
  if (command.path.at(-2) === "resources") {
    let request: WorkerResourceCommandRequest;
    if (command.command.name === "list") request = { kind: "list" };
    else {
      const target = { taskId: uuid(command.values[0]!, "Task ID"), projectId: uuid(option("--project"), "Project ID"), claimId: uuid(option("--claim-id"), "Claim ID"), sessionId: uuid(option("--session-id"), "Session ID"), worktreeId: uuid(option("--worktree-id"), "Worktree ID") };
      if (command.command.name === "retry") request = { ...target, kind: "retry" };
      else {
        const action = option("--action");
        if (action !== "abandon" && action !== "delete") throw new UsageError("Resource action must be abandon or delete.", help);
        if (!command.options.has("--confirm")) throw new UsageError("Resource disposal requires --confirm.", help);
        request = { ...target, kind: "dispose", action, operationId: uuid(option("--operation-id"), "Operation ID"), confirmed: true };
      }
    }
    await dependencies.resources({ homeDirectory: context.homeDirectory(), request, output: value => context.stdout(value) });
    return;
  }
  if (command.command.name === "list" || command.command.name === "show") {
    const request = command.command.name === "list"
      ? { kind: "list" as const, json: command.options.has("--json") }
      : { kind: "show" as const, workerId: uuid(command.values[0]!, "Worker ID"), json: command.options.has("--json") };
    await (await import("./query.js")).runWorkerQuery(request, context);
    return;
  }
  const original = { taskId: uuid(command.values[0]!, "Task ID"), claimId: uuid(option("--claim-id"), "Claim ID"), ...(rawProject === undefined ? {} : { projectId: uuid(rawProject, "Project ID") }) };
  let request: WorkerControlRequest;
  if (command.command.name === "retry") request = { ...original, kind: "retry" };
  else {
    let version: bigint;
    try { version = parseVersionArgument(option("--if-version")); }
    catch (cause) { throw new UsageError(cause instanceof Error ? cause.message : String(cause), help); }
    request = { ...original, kind: "release", version };
  }
  await dependencies.manage({ ...runtime(), version: context.version, request });
};
