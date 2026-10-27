import type { WorkerAgent } from "../../api/types.js";
import { CliCancelledError, withCliCancellation } from "../../cli/cancellation.js";
import type { CliContext } from "../../cli/context.js";
import { terminalText } from "../../platform/terminal.js";
import { resolveWorkerPaths } from "./paths.js";
import {
  configuredWorkerProjectIds, prepareWorkerSetup, readWorkerProjects, readWorkerRepositorySnapshot, saveWorkerSetup,
} from "./repositories.js";
import { inspectWorkerEnvironment } from "./setup-environment.js";
import type { WorkerEnvironmentCheck } from "./setup-environment.js";

export type WorkerSetupDependencies = {
  inspectEnvironment: typeof inspectWorkerEnvironment;
  readSnapshot: typeof readWorkerRepositorySnapshot;
  readProjects: typeof readWorkerProjects;
  prepare: typeof prepareWorkerSetup;
  save: typeof saveWorkerSetup;
};

const defaultDependencies: WorkerSetupDependencies = {
  inspectEnvironment: inspectWorkerEnvironment,
  readSnapshot: readWorkerRepositorySnapshot,
  readProjects: readWorkerProjects,
  prepare: prepareWorkerSetup,
  save: saveWorkerSetup,
};

const agentName = (agent: WorkerAgent): string => agent === "codex" ? "Codex" : "Copilot";

const renderChecks = (checks: readonly WorkerEnvironmentCheck[], context: CliContext): void => {
  for (const check of checks) {
    context.stderr(`[${check.status}] ${terminalText(check.label)}: ${terminalText(check.detail)}\n`);
    if (check.remedy !== undefined) context.stderr(`  ${terminalText(check.remedy)}\n`);
  }
};

export const runWorkerSetup = async (
  context: CliContext,
  dependencies: WorkerSetupDependencies = defaultDependencies,
  suppliedSignal?: AbortSignal,
): Promise<void> => withCliCancellation(context, async (signal) => {
  signal.throwIfAborted();
  const prompt = context.prompt;
  if (prompt?.isInteractive !== true) throw new Error("daynight worker setup requires terminal input and stderr. Run it in an interactive terminal.");
  const homeDirectory = context.homeDirectory();
  const workingDirectory = context.workingDirectory();
  const paths = resolveWorkerPaths(homeDirectory);
  const snapshot = await dependencies.readSnapshot(paths, signal);
  const environment = { homeDirectory, workingDirectory, packageDirectory: context.packageDirectory, paths, signal };
  context.stderr("Worker environment checks\n");
  const commonChecks = await dependencies.inspectEnvironment(environment);
  renderChecks(commonChecks, context);
  context.stderr(snapshot.serverToken === undefined
    ? "[missing] Daynight login: Run daynight login before selecting Projects.\n"
    : "[unverified] Daynight login: Checking access when loading Projects.\n");
  signal.throwIfAborted();
  if (snapshot.serverToken === undefined) throw new Error("You are not logged in. Run daynight login, then daynight worker setup.");
  const agent = await prompt.select<WorkerAgent>({
    message: "Which agent should execute tasks?",
    choices: [{ name: "Copilot", value: "copilot" }, { name: "Codex", value: "codex" }],
    default: snapshot.configuration.agent,
  }, signal);
  signal.throwIfAborted();
  if (agent !== "copilot" && agent !== "codex") throw new Error("Choose Codex or Copilot from the available agents.");
  const projects = await dependencies.readProjects(snapshot, signal);
  signal.throwIfAborted();
  context.stderr("[passed] Daynight login: Accessible Projects loaded from the configured service.\n");
  if (projects.length === 0) throw new Error("No accessible Daynight Projects exist. Create a Project before running daynight worker setup.");
  const configured = new Set(configuredWorkerProjectIds(snapshot, projects));
  const projectIds = await prompt.selectMany<string>({
    message: "Run tasks from which existing Daynight Projects? This replaces the configured selection.",
    choices: projects.map((project) => ({
      name: `${terminalText(project.name)} · ${project.id} · ${terminalText(project.repoUrl)}`,
      value: project.id,
      checked: configured.has(project.id),
    })),
    requiredMessage: "Select at least one Project.",
  }, signal);
  signal.throwIfAborted();
  if (projectIds.length === 0 || new Set(projectIds).size !== projectIds.length ||
    projectIds.some((id) => !projects.some((project) => project.id === id))) {
    throw new Error("Select one or more distinct Projects from the available choices.");
  }
  const options = { paths, homeDirectory, snapshot, projects, projectIds, agent, signal };
  const plan = await dependencies.prepare(options);
  signal.throwIfAborted();
  const checkedConfigurations = new Set<string>();
  const selectedChecks: WorkerEnvironmentCheck[] = [];
  for (const repository of plan.configuration.repositories) {
    const configuration = { agent: repository.agent, model: repository.model, args: repository.args };
    const identity = JSON.stringify(configuration);
    if (checkedConfigurations.has(identity)) continue;
    checkedConfigurations.add(identity);
    context.stderr(`\n${agentName(agent)} checks for Project ${repository.projectId!}\n`);
    const checks = await dependencies.inspectEnvironment({ ...environment, configuration });
    signal.throwIfAborted();
    renderChecks(checks, context);
    selectedChecks.push(...checks);
  }
  context.stderr(`\nWorker configuration\nAgent: ${agentName(agent)}\n`);
  for (const repository of plan.configuration.repositories) {
    const project = projects.find(({ id }) => id === repository.projectId)!;
    context.stderr(`Project: ${terminalText(project.name)} · ${project.id}\n  Repository: ${terminalText(repository.remote)}\n  Path: ${terminalText(repository.path)}\n`);
  }
  for (const repository of plan.removedRepositories) context.stderr(`Remove from worker selection: ${repository.projectId === undefined ? terminalText(repository.remote) : repository.projectId}\n`);
  if (plan.resetGlobalNativeSettings) context.stderr(`Reset global model and native arguments for the switch to ${agentName(agent)}.\n`);
  for (const repository of plan.resetRepositories) context.stderr(`Reset incompatible native overrides for ${repository.projectId === undefined ? terminalText(repository.remote) : repository.projectId} (${agentName(repository.agent)} → ${agentName(agent)}).\n`);
  context.stderr("Changes apply at the next worker startup. Existing execution settings remain frozen.\n");
  const save = await prompt.select<boolean>({
    message: "Save this worker configuration?",
    choices: [{ name: "Save", value: true }, { name: "Cancel", value: false }],
    default: true,
  }, signal);
  signal.throwIfAborted();
  if (save !== true) throw new CliCancelledError("Worker setup cancelled. Configuration was not saved.");
  await dependencies.save(options);
  signal.throwIfAborted();
  context.stderr(`Worker configuration saved to ${terminalText(paths.configFile)}.\n`);
  const relevantChecks = [...commonChecks.filter((check) => check.agent === undefined || check.agent === agent), ...selectedChecks];
  context.stderr(relevantChecks.some(({ status }) => status === "missing")
    ? "Repair the missing prerequisites above, then run daynight worker run.\n"
    : "Run daynight worker run. Native login, repository trust and task execution are verified when the worker starts them.\n");
}, suppliedSignal, () => new CliCancelledError("Worker setup cancelled."));
