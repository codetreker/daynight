import { mkdir } from "node:fs/promises";
import { formatError } from "../../platform/diagnostics.js";
import { createCopilotRunner } from "./adapters/copilot.js";
import { runCoordinator } from "./coordinator.js";
import { createGitManager } from "./adapters/worktrees.js";
import { createGitHubClient } from "./adapters/github.js";
import { acquireInstanceLock } from "./instance-lock.js";
import { createProcessSupervisor } from "./processes.js";
import { openStore } from "./store.js";
import { prepareReviewSkill } from "./skill.js";
import type { ReviewConfiguration } from "./config.js";
import type { CoordinatorEvent } from "./coordinator.js";
import type { ReviewPaths } from "./paths.js";

export { acquireInstanceLock } from "./instance-lock.js";

export type RuntimeDependencies = {
  prepareSkill: typeof prepareReviewSkill;
  openStore: typeof openStore;
  createClient: typeof createGitHubClient;
  createGit: typeof createGitManager;
  createRunner: typeof createCopilotRunner;
  createProcesses: typeof createProcessSupervisor;
  coordinate: typeof runCoordinator;
};
const defaultDependencies: RuntimeDependencies = {
  prepareSkill: prepareReviewSkill, openStore, createClient: createGitHubClient, createGit: createGitManager,
  createRunner: createCopilotRunner, createProcesses: createProcessSupervisor, coordinate: runCoordinator,
};

export const formatCoordinatorEvent = (event: CoordinatorEvent): string => {
  const identity = [event.repository, event.number === undefined ? undefined : `PR ${event.number}`,
    event.reviewId === undefined ? undefined : `review=${event.reviewId}`,
    event.revision === undefined ? undefined : `revision=${event.revision}`,
    event.attempt === undefined ? undefined : `attempt=${event.attempt}`].filter((value) => value !== undefined).join(" ");
  return `${identity === "" ? "" : `${identity} `}${event.phase}: ${event.message}${event.retryAt === undefined ? "" : ` retryAt=${new Date(event.retryAt).toISOString()}`}${event.error === undefined ? "" : `\n${formatError(event.error)}`}`;
};

export const runForegroundReview = async (
  configuration: ReviewConfiguration,
  paths: ReviewPaths,
  options: { packageDirectory: string; signal?: AbortSignal; log?: (event: CoordinatorEvent) => void; dependencies?: RuntimeDependencies },
): Promise<void> => {
  const dependencies = options.dependencies === undefined ? defaultDependencies : options.dependencies;
  const log = options.log === undefined ? (event: CoordinatorEvent) => { process.stderr.write(`${formatCoordinatorEvent(event)}\n`); } : options.log;
  const controller = new AbortController();
  const stop = (): void => { controller.abort(); };
  const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  if (options.signal === undefined) for (const signal of signals) process.on(signal, stop);
  const signal = options.signal === undefined ? controller.signal : options.signal;
  let lock: Awaited<ReturnType<typeof acquireInstanceLock>> | undefined;
  let store: ReturnType<typeof openStore> | undefined;
  let safe = true;
  let failure: unknown;
  try {
    await mkdir(paths.stateDirectory, { recursive: true });
    lock = await acquireInstanceLock(paths.lockFile);
    safe = lock.previousProcessesExcluded;
    signal.throwIfAborted();
    const skill = await dependencies.prepareSkill(options.packageDirectory, paths.cacheDirectory);
    signal.throwIfAborted();
    store = dependencies.openStore(paths.databaseFile, {
      onMigration: event => { log({ level: event.kind === "failed" ? "error" : "info", phase: `sqlite-migration-${event.kind}`, message: JSON.stringify(event) }); },
    });
    const client = dependencies.createClient();
    const git = dependencies.createGit({ temporaryDirectory: paths.temporaryDirectory, client });
    const processes = dependencies.createProcesses(lock.previousProcessesExcluded ? { previousProcessesExcluded: true } : {});
    const runner = dependencies.createRunner({ paths, skill, processOwner: lock.owner, timeoutMs: configuration.agentTimeoutMs,
      ...(configuration.copilotModel === undefined ? {} : { model: configuration.copilotModel }),
      ...(configuration.copilotReasoningEffort === undefined ? {} : { reasoningEffort: configuration.copilotReasoningEffort }) });
    log({ level: "info", phase: "startup", message: `Foreground review started; state=${paths.stateDirectory}; skill=${skill.name} digest=${skill.digest}.` });
    safe = false;
    const result = await dependencies.coordinate({ configuration, store, client, git, runner, processes, signal, log });
    safe = result.safeToReleaseLock && processes.safeToReleaseLock;
    if (!safe) throw new Error(`Review execution could not be confirmed stopped. Instance lock ${paths.lockFile} and interrupted state were retained; confirm the CLI and all review agents have stopped before manually removing the lock.`);
  } catch (error) { failure = error; }
  try { store?.close(); } catch (error) { safe = false; failure = failure === undefined ? error : new AggregateError([failure, error], "Review execution and database shutdown failed."); }
  if (lock !== undefined && safe) {
    try { await lock.release(); } catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Review execution and instance-lock release failed."); }
  }
  if (options.signal === undefined) for (const signal of signals) process.off(signal, stop);
  if (failure !== undefined) throw failure;
};
