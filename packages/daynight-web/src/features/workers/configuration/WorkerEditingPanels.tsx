import { useLayoutEffect } from 'react';
import type { ExecutionPlatform } from '../../../api/types';
import type { WorkerTaskSnapshot } from '../../../api/workers';
import type { ToolPathTelemetry } from '../../../api/worker-tool-paths';
import { WorkerPromptEditor } from '../../worker-prompts/WorkerPromptEditor';
import { useWorkerPrompt } from '../../worker-prompts/useWorkerPrompt';
import { WorkerConfigurationPanel } from './WorkerConfigurationPanel';
import { useWorkerConfiguration } from './useWorkerConfiguration';
import { configurationDraftsEqual } from './model';
import { useWorkerConfigurationNavigation } from './WorkerConfigurationNavigation';

export const WorkerEditingPanels = ({ id, workerId, platform, section, readEnabled, online, tasks, toolPaths, onContinueEditing, onRetentionChange }: {
  readonly id: string;
  readonly workerId: string;
  readonly platform?: ExecutionPlatform;
  readonly section: 'overview' | 'configuration' | 'prompt';
  readonly readEnabled: boolean;
  readonly online: boolean | null;
  readonly tasks: readonly WorkerTaskSnapshot[];
  readonly toolPaths?: ToolPathTelemetry;
  readonly onContinueEditing: (editor: 'configuration' | 'prompt') => void;
  readonly onRetentionChange?: (retain: boolean) => void;
}) => {
  const configurationRead = readEnabled && section === 'configuration', promptRead = readEnabled && section === 'prompt';
  const state = useWorkerConfiguration(workerId, { readEnabled: configurationRead, toolPathsEditable: toolPaths !== undefined, ...(platform === undefined ? {} : { platform }) });
  const prompt = useWorkerPrompt({ scope: 'worker', workerId }, { readEnabled: promptRead });
  const navigation = useWorkerConfigurationNavigation({ workerId, configurationDirty: !state.unavailable && state.dirty, promptDirty: !prompt.unavailable && prompt.dirty,
    unavailable: state.unavailable && (prompt.unavailable || !prompt.dirty), discard: () => { state.abandon(); prompt.abandon(); }, section, onContinueEditing });
  useLayoutEffect(() => { onRetentionChange?.(state.pending || state.uncertain || state.publicationPending || prompt.pending || prompt.confirmed || prompt.uncertain); }, [onRetentionChange, state.pending, state.uncertain, state.publicationPending, prompt.pending, prompt.confirmed, prompt.uncertain]);
  return <div ref={navigation.owner}>
    <section className="worker-section" id={`${id}-panel-configuration`} data-worker-panel="configuration" role="tabpanel" aria-labelledby={`${id}-tab-configuration`} hidden={section !== 'configuration'} inert={section !== 'configuration'} onFocusCapture={event => navigation.rememberFocus('configuration', event)}>
      <WorkerConfigurationPanel workerId={workerId} {...(platform === undefined ? {} : { platform })} visible={section === 'configuration'} readEnabled={configurationRead} online={online} tasks={tasks} {...(toolPaths === undefined ? {} : { toolPaths })} state={{ ...state, setDraft: update => state.setDraft(old => { const next = typeof update === 'function' ? update(old) : update; if (!configurationDraftsEqual(old, next)) navigation.markEdited('configuration'); return next; }) }} confirming={navigation.confirming} />
    </section>
    <section className="worker-section" id={`${id}-panel-prompt`} data-worker-panel="prompt" role="tabpanel" aria-labelledby={`${id}-tab-prompt`} hidden={section !== 'prompt'} inert={section !== 'prompt'} onFocusCapture={event => navigation.rememberFocus('prompt', event)}>
      <WorkerPromptEditor state={{ ...prompt, edit: text => { if (text !== prompt.draft) navigation.markEdited('prompt'); prompt.edit(text); } }} scope="worker" />
    </section>
    {navigation.confirmation}
  </div>;
};
