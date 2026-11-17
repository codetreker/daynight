import type { WorkerConfigurationResource } from '../../api/worker-configuration';
import { sameToolPathChoice, type Tool, type ToolContext, type ToolPathObservation, type ToolPathTelemetry } from '../../api/worker-tool-paths';

export type ToolPathApplicationState = 'not_checked' | 'checking' | 'pending' | 'applied' | 'error' | 'offline' | 'unconfirmed';
export const toolPathApplicationState = (entry: ToolPathObservation | undefined, desired: WorkerConfigurationResource['desired'] | undefined, online: boolean | null): ToolPathApplicationState => {
  if (entry === undefined) return 'not_checked';
  if (online === false) return 'offline';
  if (online === null || desired == null || desired.value.toolPaths === undefined) return 'unconfirmed';
  const target = desired.value.toolPaths[entry.tool];
  if (target === null) return 'not_checked';
  if (entry.configurationSource !== 'cloud' || entry.targetRevision !== desired.revision || !sameToolPathChoice(entry.target, target)) return 'pending';
  if (entry.state === 'applied' && (entry.actual === null || !sameToolPathChoice(entry.actual.selection, target))) return 'pending';
  return entry.state;
};

export const toolPathSummaryStates = (resource: WorkerConfigurationResource, telemetry: ToolPathTelemetry | undefined, online: boolean | null): readonly ToolPathApplicationState[] => {
  if (resource.toolPathsSupported !== true || telemetry === undefined || resource.desired === null) return ['not_checked'];
  const { desired } = resource;
  return (['codex', 'copilot'] as const).map(tool => {
    const entry = telemetry.entries.find(item => item.tool === tool && item.context === 'web');
    const state = toolPathApplicationState(entry, desired, online);
    const required = desired.value.toolPaths?.[tool]?.kind === 'path' || tool === desired.value.native.agent;
    return state === 'error' && !required ? 'not_checked' : state;
  });
};

export const toolPathContexts = (_tool: Tool, _primary: ToolContext = 'web'): readonly ToolContext[] => ['web'];

export const toolSoftwareEntries = (telemetry: ToolPathTelemetry, tool: Tool): readonly ToolPathObservation[] => telemetry.entries.filter(entry => entry.tool === tool && !(
  entry.state === 'not_checked' && entry.actual === null && entry.candidate === null && entry.reason === null && entry.error === null
  && entry.activeSelectionCount === 0 && entry.activeSelectionsComplete && entry.activeObservationError === null && entry.activeSelections.length === 0
));
