import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { ApiError, createApiClient } from "../../../api/client.js";
import { canonicalId } from "../../../api/parse.js";
import { createOperation, type Operation } from "../../../api/operation.js";
import { prepareAgentCliAliases, type AgentCliAliasBinding, type PreparedAgentCliAliases } from "../../../cli/agent-cli-aliases.js";
import { readAgentCliAliases } from "../../../config/agent-cli-aliases.js";
import { resolveConfigurationPaths, type ConfigurationPaths } from "../../../config/paths.js";
import { loadServerConfiguration, normalizeServerUrl } from "../../../config/server.js";
import type { HerdrCommand, HerdrCommandResult } from "../herdr/command.js";
import { BotCliProbeCleanupError, createBotCliProbe, type BotCliProbe } from "./cli-probe.js";
import { loadOperationFiles } from "../../task/session/private-files.js";

export type BotEnvironmentOptions = {
  homeDirectory: string;
  cwd: string;
  workerPaths: ConfigurationPaths;
  serverOrigin: string;
  ownerUserId: string;
  botId: string;
  signal: AbortSignal;
  environment?: NodeJS.ProcessEnv;
};

export type PreparedBotEnvironment = {
  environment: NodeJS.ProcessEnv;
  aliasDirectory: string | null;
  bindings: readonly AgentCliAliasBinding[];
  /** Release only after every descendant using these aliases has stopped. */
  release(): Promise<void>;
};

export type BotEnvironmentDependencies = {
  fetch?: typeof globalThis.fetch;
  /** Overrides must join all descendants before settling, or reject BotCliProbeCleanupError with retryable ownership. */
  runCommand?: (command: HerdrCommand, operation: Operation) => Promise<HerdrCommandResult>;
};

export class BotEnvironmentCleanupError extends Error {
  constructor(readonly aliasDirectory: string | null, readonly probe: BotCliProbeCleanupError) {
    super("Bot CLI preparation cleanup is unconfirmed; retry cleanup before releasing its retained aliases.");
    this.name = "BotEnvironmentCleanupError";
  }
  get ownership() { return this.probe.ownership; }
  async retryCleanup(): Promise<void> {
    await this.probe.retryCleanup();
    if (this.aliasDirectory !== null) await rm(this.aliasDirectory, { recursive: true, force: true });
  }
}

const queries = ["project", "task", "bot", "worker"].flatMap(resource => ["list", "show"].map(action => [resource, action]));

export const botStateDirectory = (workerPaths: Pick<ConfigurationPaths, "stateDirectory">, botId: string): string => {
  if (canonicalId(botId) !== botId || botId === "00000000-0000-0000-0000-000000000000") throw new Error("Bot ID must be a nonzero canonical UUID.");
  if (!path.isAbsolute(workerPaths.stateDirectory)) throw new Error("Bot state requires an absolute Worker configuration directory.");
  return path.join(workerPaths.stateDirectory, "bots", botId, "state");
};

/** Durable claim state outlives Controller launches and temporary CLI aliases. */
export const prepareBotStateDirectory = async (workerPaths: Pick<ConfigurationPaths, "stateDirectory">, botId: string): Promise<string> => {
  const directory = botStateDirectory(workerPaths, botId);
  const handle = await (await loadOperationFiles()).open(directory, true);
  if (handle === undefined) throw new Error("Bot private state directory is unavailable.");
  await handle.close();
  return directory;
};

/**
 * Check the current CLI configuration and executable before a Bot launch or
 * resume. This is an observation, not a lock against later account changes.
 * Credentials stay in the normal CLI configuration and never enter the result.
 */
export const prepareBotEnvironment = async (
  options: BotEnvironmentOptions,
  dependencies: BotEnvironmentDependencies = {},
): Promise<PreparedBotEnvironment> => {
  options.signal.throwIfAborted();
  botStateDirectory(options.workerPaths, options.botId);
  const paths = resolveConfigurationPaths(options.homeDirectory, path, { DN_CONFIG_DIR: options.workerPaths.stateDirectory });
  if (paths.stateDirectory !== options.workerPaths.stateDirectory || paths.configFile !== options.workerPaths.configFile) {
    throw new Error("Bot CLI configuration paths must match the target Worker's configuration root.");
  }
  if (!path.isAbsolute(options.cwd) || /\p{Cc}/u.test(options.cwd) || !(await stat(options.cwd)).isDirectory()) {
    throw new Error("Bot CLI working directory must be an accessible absolute directory.");
  }
  const operation = createOperation({ signal: options.signal, limits: { totalMs: 90_000, requestMs: 5_000, totalBytes: 1_048_576, responseBytes: 65_536 } });
  let aliases: PreparedAgentCliAliases | undefined;
  let probe: BotCliProbe | undefined;
  try {
    const configuration = await loadServerConfiguration(paths, operation.signal);
    if (configuration.serverUrl !== normalizeServerUrl(options.serverOrigin)) throw new Error("Bot CLI server does not match the target Worker's server.");
    if (configuration.serverToken === undefined) throw new Error("Bot CLI authentication is missing. Run daynight login with the target Worker's DN_CONFIG_DIR.");
    try {
      await createApiClient({ ...configuration, expectedUserId: options.ownerUserId, operation, ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }) }).getCurrentUser(true);
    } catch (error) {
      operation.check();
      // Account validation needs HTTP status and protocol failure semantics,
      // never server-controlled messages, request IDs, or nested response errors.
      if (error instanceof ApiError) throw new ApiError({ operation: "auth.me" }, error.phase, { cause: undefined, ...(error.status === undefined ? {} : { status: error.status }) });
      throw new Error("Cannot verify the Bot CLI account against the target Worker's owner.");
    }
    const configuredAliases = await readAgentCliAliases(paths, operation.signal);
    const stateDirectory = await prepareBotStateDirectory(paths, options.botId);
    const environment: NodeJS.ProcessEnv = { ...(options.environment ?? process.env), DN_CONFIG_DIR: paths.stateDirectory,
      DAYNIGHT_BOT_ID: options.botId, DAYNIGHT_BOT_STATE_DIR: stateDirectory };
    // The Controller's relay credential authorizes its connection, not CLI API calls.
    delete environment.DAYNIGHT_CONTROLLER_TOKEN;
    aliases = await prepareAgentCliAliases({ aliases: configuredAliases, environment, stateDirectory: paths.stateDirectory });
    if (dependencies.runCommand === undefined) probe = await createBotCliProbe({ environment: aliases.environment, cwd: options.cwd }, operation);
    const runCommand = dependencies.runCommand ?? ((command: HerdrCommand) => probe!.run(command.file, command.args));
    for (const query of queries) {
      operation.check();
      let output: HerdrCommandResult;
      try { output = await runCommand({ file: "daynight", args: [...query, "--help"], environment: aliases.environment, cwd: options.cwd }, operation); }
      catch (error) {
        if (error instanceof BotCliProbeCleanupError) throw error;
        operation.check();
        throw new Error(`Daynight CLI capability check failed for ${query.join(" ")}; install a compatible CLI or correct agentCliAliases.`);
      }
      operation.check();
      if (!new RegExp(`^Usage: daynight ${query.join(" ")}(?: |$)`, "m").test(output.stdout) || !output.stdout.includes("--json")) {
        throw new Error(`Daynight CLI does not advertise ${query.join(" ")} --json; install a compatible CLI or correct agentCliAliases.`);
      }
    }
    await probe?.close();
    const current = await loadServerConfiguration(paths, operation.signal);
    const currentAliases = await readAgentCliAliases(paths, operation.signal);
    if (current.serverUrl !== configuration.serverUrl || current.serverToken !== configuration.serverToken
      || currentAliases.daynight !== configuredAliases.daynight || currentAliases.dn !== configuredAliases.dn) {
      throw new Error("Bot CLI configuration changed during preparation; verify the current account and prepare again.");
    }
    operation.check();
    const aliasDirectory = aliases.directory;
    return {
      environment: aliases.environment, aliasDirectory, bindings: aliases.bindings,
      release: async () => { if (aliasDirectory !== null) await rm(aliasDirectory, { recursive: true, force: true }); },
    };
  } catch (error) {
    let cleanup = error instanceof BotCliProbeCleanupError ? error : undefined;
    if (cleanup === undefined) {
      try { await probe?.close(); }
      catch (failure) { if (failure instanceof BotCliProbeCleanupError) cleanup = failure; else throw failure; }
    }
    if (cleanup !== undefined) throw new BotEnvironmentCleanupError(aliases?.directory ?? null, cleanup);
    if (aliases?.directory) {
      try { await rm(aliases.directory, { recursive: true, force: true }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Bot CLI preparation and alias cleanup failed."); }
    }
    throw error;
  } finally { operation.dispose(); }
};
