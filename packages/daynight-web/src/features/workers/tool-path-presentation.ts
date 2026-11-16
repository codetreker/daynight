import type { WorkerConfigurationResource } from '../../api/worker-configuration';
import { resolvedProjectNative } from './configuration/model';
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
  if (resource.toolPathsSupported !== true || resource.desired === null) return ['not_checked'];
  const { desired } = resource;
  const mode = desired.value.agentControlMode;
  if (mode == null) return ['unconfirmed'];
  const agents = new Set([desired.value.native.agent, ...desired.value.projects.map(project => resolvedProjectNative(desired.value.native, project.nativeOverrides).agent)]);
  // Configuration depends on the target mode and its selected providers, while
  // detail views retain checks and running selections from every context.
  const required = (['codex', 'copilot', 'herdr'] as const).filter(tool => tool === 'herdr' ? mode === 'herdr' : agents.has(tool));
  return required.map(tool => toolPathApplicationState(telemetry?.entries.find(item => item.tool === tool && item.context === mode), desired, online));
};

export const toolPathContexts = (tool: Tool, primary: ToolContext = 'web'): readonly ToolContext[] => tool === 'herdr' ? ['herdr'] : [primary, primary === 'web' ? 'herdr' : 'web'];

export const toolSoftwareEntries = (telemetry: ToolPathTelemetry, tool: Tool): readonly ToolPathObservation[] => telemetry.entries.filter(entry => entry.tool === tool && !(
  entry.state === 'not_checked' && entry.actual === null && entry.candidate === null && entry.reason === null && entry.error === null
  && entry.activeSelectionCount === 0 && entry.activeSelectionsComplete && entry.activeObservationError === null && entry.activeSelections.length === 0
));
