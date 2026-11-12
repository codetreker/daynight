import path from "node:path";
import { createOperation } from "../../src/api/operation.js";
import type { WorkerCloudNative } from "../../src/api/worker-configuration.js";
import type { AgentControlMode } from "../../src/api/types.js";
import type { ExecutionConfiguration } from "../../src/commands/worker/types.js";
import { probeNativeAgentVersion } from "../../src/commands/worker/herdr/version-probe.js";

/** Configuration orchestration fixtures supply their probe outcome and never discover tools on the host. */
export const createWorkerToolSelectionFixture = (options: { workerDirectory: string; cwd: string; environment: NodeJS.ProcessEnv }) => ({
  configurationOptions: {},
  manager: { currentSelection: () => undefined, snapshot: () => ({ schemaVersion: 1, observedAt: new Date().toISOString(), entries: [] }) },
  setTargets: () => {},
  toolRuntimeRoot: path.join(options.workerDirectory, "tool-runtimes"),
  toolObservationFor: () => undefined,
  selectToolLaunch: async () => { throw new Error("This orchestration fixture has no native tool launch."); },
  hostInspector: { check: async () => { throw new Error("This orchestration fixture has no native tool observation."); } },
  prepareWebCandidates: async () => false,
  prepareHerdrCandidate: async () => false,
  prepareNative: async (native: WorkerCloudNative, mode: AgentControlMode, signal: AbortSignal) => {
    if (native.agent === "claude") return;
    const operation = createOperation({ signal, limits: { totalMs: 15_000, requestMs: 10_000 } });
    try { await probeNativeAgentVersion({ agent: native.agent, cwd: options.cwd, environment: options.environment }, operation); }
    finally { operation.dispose(); }
  },
  freezeConfiguration: async (configuration: ExecutionConfiguration) => configuration,
  close: async () => {},
});
