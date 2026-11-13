import path from "node:path";
import { createOperation, type Operation } from "../../api/operation.js";
import type { WorkerCloudNative } from "../../api/worker-configuration.js";
import type { AgentControlMode } from "../../api/types.js";
import { ToolSelectionError, verifyToolLaunch, type ResolvedToolLaunch, type ToolPaths } from "../../platform/tool-executables.js";
import { createCopilotToolMaterializer } from "./copilot-tool-materializer.js";
import { createWorkerToolInspector } from "./native-selection.js";
import { ToolSelectionManager, type ActiveToolSelection, type ToolSelectionTargets } from "./tool-selection.js";
import type { ExecutionConfiguration } from "./types.js";

/** One Worker lifetime owns all candidate recipes, probe cleanup and published runtime dependencies. */
export const createWorkerToolSelectionRuntime = (options: {
  workerDirectory: string; cwd: string; environment: NodeJS.ProcessEnv; localToolPaths: ToolPaths;
  readActiveSelections: () => readonly ActiveToolSelection[];
}) => {
  const toolRuntimeRoot = path.join(options.workerDirectory, "tool-runtimes");
  const materializer = createCopilotToolMaterializer({ workerDirectory: options.workerDirectory, environment: options.environment });
  const inspector = createWorkerToolInspector({ cwd: options.cwd, environment: options.environment, toolRuntimeRoot });
  const manager = new ToolSelectionManager({ ...options, probe: { ...inspector, cacheToken: inspector.revision }, prepareLaunch: materializer.prepare,
    verify: (launch, operation) => verifyToolLaunch(launch, operation, { trustedRuntimeRoot: toolRuntimeRoot }) });
  let targetSignature = "", nextPreparationAt = 0, preparing: Promise<boolean> | undefined;
  let lastCopilotRequired: boolean | undefined;
  const setTargets = (targets: ToolSelectionTargets | null): void => {
    if (targets === null) { manager.suspendTargets(); targetSignature = ""; nextPreparationAt = 0; return; }
    const signature = JSON.stringify(targets.choices);
    if (signature !== targetSignature) { targetSignature = signature; nextPreparationAt = 0; }
    manager.setTargets(targets);
  };
  setTargets({ source: "local", revision: null, choices: options.localToolPaths });
  const withOperation = async <T>(signal: AbortSignal, action: (operation: Operation) => Promise<T>): Promise<T> => {
    const operation = createOperation({ signal, limits: { totalMs: 65_000, requestMs: 60_000 } });
    try { return await action(operation); } finally { operation.dispose(); }
  };
  const prepareNative = async (native: WorkerCloudNative, mode: AgentControlMode, signal: AbortSignal): Promise<void> => withOperation(signal, async operation => {
    if (native.agent === "codex" || native.agent === "copilot") await manager.prepare(native.agent, mode, operation);
    if (mode === "herdr") await manager.prepare("herdr", "herdr", operation);
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
    toolObservationFor: (launch: ResolvedToolLaunch) => manager.observationFor(launch),
    prepareNative,
    configurationOptions: {
      allowLegacyHerdrAuto: true,
      readToolSelectionKeys: (native: WorkerCloudNative, mode: AgentControlMode) => native.agent === "codex" || native.agent === "copilot" ? { [native.agent]: manager.currentSelection(native.agent, mode)?.selectionKey } : {},
      prepareToolSelection: async (native: WorkerCloudNative, mode: AgentControlMode, targets: ToolSelectionTargets, signal: AbortSignal): Promise<void> => { setTargets(targets); await prepareNative(native, mode, signal); },
    },
    freezeConfiguration: async (configuration: ExecutionConfiguration, signal: AbortSignal): Promise<ExecutionConfiguration> => {
      if (configuration.toolLaunch !== undefined) return configuration;
      const mode = configuration.agentControlMode ?? "herdr";
      if (mode === "herdr") { await prepareNative(configuration, mode, signal); return configuration; }
      if (configuration.agent !== "codex" && configuration.agent !== "copilot") return configuration;
      const toolLaunch = await selectToolLaunch(configuration.agent, signal), toolObservation = manager.observationFor(toolLaunch);
      if (toolObservation === undefined) throw new Error("The selected tool observation changed before its configuration could be frozen.");
      return { ...configuration, toolLaunch, toolObservation };
    },
    close: async (): Promise<void> => {
      const operation = createOperation({ limits: { totalMs: 30_000 } });
      try {
        const results = await Promise.allSettled([manager.close(operation), materializer.close(operation)]);
        const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, "Worker tool selection cleanup remains unconfirmed.");
      } finally { operation.dispose(); }
    },
  };
};
