import type { Tool, ToolContext, ToolPathActual, ToolPathObservation, ToolPathTelemetry, WorkerCloudToolPaths } from '../../src/api/worker-tool-paths';
import { configurationResource, configurationValue } from './worker-configuration';
import { WORKER_TIME } from './workers';

export const automaticToolPaths = (): WorkerCloudToolPaths => ({ codex: { kind: 'auto' }, copilot: { kind: 'auto' }, herdr: { kind: 'auto' } });
export const toolPathActual = (tool: Tool = 'codex', changes: Partial<ToolPathActual> = {}): ToolPathActual => ({
  selection: { kind: 'auto' }, selectionKey: 'a'.repeat(64), entryPath: `/tools/${tool}`, executablePath: `/tools/${tool}`, interpreterPath: null,
  source: 'path', version: '1.2.3', checkedAt: WORKER_TIME, ...changes,
});
export const toolPathObservation = (tool: Tool = 'codex', context: ToolContext = tool === 'herdr' ? 'herdr' : 'web', changes: Partial<ToolPathObservation> = {}): ToolPathObservation => ({
  tool, context, configurationSource: 'cloud', targetRevision: '1', target: { kind: 'auto' }, state: 'applied', reason: null,
  actual: toolPathActual(tool), candidate: null, activeSelectionCount: 0, activeSelectionsComplete: true, activeObservationError: null, activeSelections: [], error: null, ...changes,
});
export const toolPathTelemetry = (entries: readonly ToolPathObservation[] = [toolPathObservation(), toolPathObservation('copilot'), toolPathObservation('herdr')]): ToolPathTelemetry => ({ schemaVersion: 1, observedAt: WORKER_TIME, entries });
export const toolPathConfiguration = (revision = '1', toolPaths = automaticToolPaths()) => ({ ...configurationResource(revision, { ...configurationValue(), agentControlMode: 'web', toolPaths }), controlModeSupported: true, toolPathsSupported: true });
