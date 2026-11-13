import path from "node:path";
import { createOperation, type Operation } from "../../api/operation.js";
import type { WorkerCloudNative } from "../../api/worker-configuration.js";
import type { AgentControlMode } from "../../api/types.js";
import { ToolSelectionError, verifyToolLaunch, type ResolvedToolLaunch, type ToolPaths } from "../../platform/tool-executables.js";
import { createCopilotToolMaterializer } from "./copilot-tool-materializer.js";
import { createWorkerToolInspector } from "./native-selection.js";
import { ToolSelectionManager, type ActiveToolSelection, type ToolSelectionTargets, type HerdrToolAdmission } from "./tool-selection.js";
import type { ExecutionConfiguration } from "./types.js";

/** One Worker lifetime owns all candidate recipes, probe cleanup and published runtime dependencies. */
export const createWorkerToolSelectionRuntime = (options: {
  workerDirectory: string; cwd: string; environment: NodeJS.ProcessEnv; localToolPaths: ToolPaths;
  readActiveSelections: () => readonly ActiveToolSelection[];
  admitHerdr?: HerdrToolAdmission;
  closeHerdr?: (operation: Operation) => Promise<void>;
}) => {
  const toolRuntimeRoot = path.join(options.workerDirectory, "tool-runtimes");
  const materializer = createCopilotToolMaterializer({ workerDirectory: options.workerDirectory, environment: options.environment });
  const inspector = createWorkerToolInspector({ cwd: options.cwd, environment: options.environment, toolRuntimeRoot });
  const manager = new ToolSelectionManager({ ...options, probe: { ...inspector, cacheToken: inspector.revision }, prepareLaunch: materializer.prepare,
    verify: (launch, operation) => verifyToolLaunch(launch, operation, { trustedRuntimeRoot: toolRuntimeRoot }) });
  let targetSignature = "", nextPreparationAt = 0, preparing: Promise<boolean> | undefined;
  let lastCopilotRequired: boolean | undefined;
  let nextHerdrPreparationAt = 0, preparingHerdr: Promise<boolean> | undefined;
  const setTargets = (targets: ToolSelectionTargets | null): void => {
    if (targets === null) { manager.suspendTargets(); targetSignature = ""; nextPreparationAt = 0; nextHerdrPreparationAt = 0; return; }
    const signature = JSON.stringify(targets.choices);
    if (signature !== targetSignature) { targetSignature = signature; nextPreparationAt = 0; nextHerdrPreparationAt = 0; }
    manager.setTargets(targets);
  };
  setTargets({ source: "local", revision: null, choices: options.localToolPaths });
  const withOperation = async <T>(signal: AbortSignal, action: (operation: Operation) => Promise<T>): Promise<T> => {
    const operation = createOperation({ signal, limits: { totalMs: 65_000, requestMs: 60_000 } });
    try { return await action(operation); } finally { operation.dispose(); }
  };
  const prepareNative = async (native: WorkerCloudNative, mode: AgentControlMode, signal: AbortSignal): Promise<void> => withOperation(signal, async operation => {
    if (native.agent === "codex" || native.agent === "copilot") await manager.prepare(native.agent, mode, operation);
    if (mode === "herdr") {
      if (options.admitHerdr) await manager.selectForNewExecution("herdr", "herdr", operation);
      else await manager.prepare("herdr", "herdr", operation);
    }
  });
  const selectToolLaunch = (agent: "codex" | "copilot", signal: AbortSignal): Promise<ResolvedToolLaunch> => withOperation(signal, operation => manager.selectForNewExecution(agent, "web", operation));
  return {
    manager, inspector, toolRuntimeRoot, selectToolLaunch, setTargets,
    hostInspector: { ...inspector, check: async (launch: ResolvedToolLaunch, operation: Operation) => {
      operation.check(); const observation = manager.observationFor(launch);
      if (observation === undefined) throw new Error("The selected tool has no current inspection proof.");
      return observation;
    } },
    prepareWebCandidates: (signal: AbortSignal, copilotRequired: boolean): Promise<boolean> => {
      if (copilotRequired !== lastCopilotRequired) { lastCopilotRequired = copilotRequired; nextPreparationAt = 0; }
      if (preparing !== undefined) return Promise.resolve(false);
      if (Date.now() < nextPreparationAt || signal.aborted) return Promise.resolve(false);
      nextPreparationAt = Date.now() + 60_000;
      const tools = copilotRequired ? ["codex", "copilot"] as const : ["codex"] as const;
      const job = Promise.allSettled(tools.map(tool => withOperation(signal, async operation => {
        try { await manager.prepare(tool, "web", operation); }
        catch (error) {
          if (!(error instanceof ToolSelectionError) || error.code !== "tool_identity_changed") throw error;
          await manager.prepare(tool, "web", operation);
        }
      }))).then(() => true);
      preparing = job;
      void job.finally(() => { if (preparing === job) preparing = undefined; });
      return job;
    },
    prepareHerdrCandidate: (signal: AbortSignal): Promise<boolean> => {
      if (!options.admitHerdr || preparingHerdr !== undefined || Date.now() < nextHerdrPreparationAt || signal.aborted) return Promise.resolve(false);
      nextHerdrPreparationAt = Date.now() + 60_000;
      const job = Promise.allSettled([withOperation(signal, operation => manager.prepare("herdr", "herdr", operation))]).then(() => true);
      preparingHerdr = job;
      void job.finally(() => { if (preparingHerdr === job) preparingHerdr = undefined; });
      return job;
    },
    toolObservationFor: (launch: ResolvedToolLaunch) => manager.observationFor(launch),
    prepareNative,
    configurationOptions: {
      allowLegacyHerdrAuto: options.admitHerdr === undefined,
      readToolSelectionKeys: (native: WorkerCloudNative, mode: AgentControlMode) => {
        const keys: Partial<Record<"codex" | "copilot" | "herdr", string>> = {};
        if (native.agent === "codex" || native.agent === "copilot") {
          const launch = manager.currentSelection(native.agent, mode);
          if (launch !== undefined) keys[native.agent] = launch.selectionKey;
        }
        const herdr = mode === "herdr" ? manager.currentSelection("herdr", "herdr") : undefined;
        if (herdr !== undefined) keys.herdr = herdr.selectionKey;
        return keys;
      },
      prepareToolSelection: async (native: WorkerCloudNative, mode: AgentControlMode, targets: ToolSelectionTargets, signal: AbortSignal): Promise<void> => { setTargets(targets); await prepareNative(native, mode, signal); },
    },
    freezeConfiguration: async (configuration: ExecutionConfiguration, signal: AbortSignal): Promise<ExecutionConfiguration> => {
      if (configuration.toolLaunch !== undefined || configuration.herdrLaunch !== undefined) return configuration;
      const mode = configuration.agentControlMode ?? "herdr";
      if (mode === "herdr") {
        if (options.admitHerdr === undefined) { await prepareNative(configuration, mode, signal); return configuration; }
        return withOperation(signal, async operation => {
          for (;;) {
            const herdrLaunch = await manager.selectForNewExecution("herdr", "herdr", operation);
            const toolLaunch = configuration.agent === "claude" ? undefined : await manager.selectForNewExecution(configuration.agent, "herdr", operation);
            const herdrObservation = manager.observationFor(herdrLaunch), toolObservation = toolLaunch === undefined ? undefined : manager.observationFor(toolLaunch);
            if (!herdrObservation || toolLaunch !== undefined && !toolObservation) { operation.check(); continue; }
            return { ...configuration, herdrLaunch, herdrObservation, ...(toolLaunch === undefined ? {} : { toolLaunch, toolObservation: toolObservation! }) };
          }
        });
      }
      if (configuration.agent !== "codex" && configuration.agent !== "copilot") return configuration;
      const toolLaunch = await selectToolLaunch(configuration.agent, signal), toolObservation = manager.observationFor(toolLaunch);
      if (toolObservation === undefined) throw new Error("The selected tool observation changed before its configuration could be frozen.");
      return { ...configuration, toolLaunch, toolObservation };
    },
    close: async (): Promise<void> => {
      const operation = createOperation({ limits: { totalMs: 30_000 } });
      try {
        const results = await Promise.allSettled([manager.close(operation), materializer.close(operation), ...(options.closeHerdr ? [options.closeHerdr(operation)] : [])]);
        const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, "Worker tool selection cleanup remains unconfirmed.");
      } finally { operation.dispose(); }
    },
  };
};
