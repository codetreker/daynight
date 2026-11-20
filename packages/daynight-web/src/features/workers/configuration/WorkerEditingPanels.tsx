import { useLayoutEffect, useState } from 'react';
import type { ExecutionPlatform } from '../../../api/types';
import type { WorkerTaskSnapshot } from '../../../api/workers';
import type { ToolPathTelemetry } from '../../../api/worker-tool-paths';
import { WorkerPromptEditor, type PromptPurpose } from '../../worker-prompts/WorkerPromptEditor';
import { useWorkerPrompt } from '../../worker-prompts/useWorkerPrompt';
import { WorkerConfigurationPanel } from './WorkerConfigurationPanel';
import { useWorkerConfiguration } from './useWorkerConfiguration';
import { configurationDraftsEqual } from './model';
import { useWorkerConfigurationNavigation } from './WorkerConfigurationNavigation';

export const WorkerEditingPanels = ({ id, workerId, platform, section, readEnabled, online, tasks, toolPaths, onRevealToolPaths, onContinueEditing, onRetentionChange }: {
  readonly onRevealToolPaths?: () => void;
  readonly id: string;
  readonly workerId: string;
  readonly platform?: ExecutionPlatform;
  readonly section: 'overview' | 'system' | 'configuration' | 'prompt';
  readonly readEnabled: boolean;
  readonly online: boolean | null;
  readonly tasks: readonly WorkerTaskSnapshot[];
  readonly toolPaths?: ToolPathTelemetry;
  readonly onContinueEditing: (editor: 'configuration' | 'prompt') => void;
  readonly onRetentionChange?: (retain: boolean) => void;
}) => {
  const configurationRead = readEnabled && section === 'configuration', promptRead = readEnabled && section === 'prompt';
  const state = useWorkerConfiguration(workerId, { readEnabled: configurationRead, toolPathsEditable: toolPaths !== undefined, ...(platform === undefined ? {} : { platform }) });
  const [purpose, setPurpose] = useState<PromptPurpose>('worker');
  const prompt = useWorkerPrompt({ scope: 'worker', workerId }, { readEnabled: promptRead && purpose === 'worker' });
  const reviewer = useWorkerPrompt({ scope: 'worker', workerId, purpose: 'reviewer' }, { readEnabled: promptRead && purpose === 'reviewer' });
  const selectedPrompt = purpose === 'worker' ? prompt : reviewer;
  const navigation = useWorkerConfigurationNavigation({ workerId, configurationDirty: !state.unavailable && state.dirty, promptDirty: (!prompt.unavailable && prompt.dirty) || (!reviewer.unavailable && reviewer.dirty),
    unavailable: state.unavailable && (prompt.unavailable || !prompt.dirty) && (reviewer.unavailable || !reviewer.dirty), discard: () => { state.abandon(); prompt.abandon(); reviewer.abandon(); }, section, onContinueEditing: editor => { if (editor === 'prompt') { if (purpose === 'worker' && !prompt.dirty && reviewer.dirty) setPurpose('reviewer'); if (purpose === 'reviewer' && !reviewer.dirty && prompt.dirty) setPurpose('worker'); } onContinueEditing(editor); } });
  useLayoutEffect(() => { onRetentionChange?.(state.pending || state.uncertain || state.publicationPending || prompt.pending || prompt.confirmed || prompt.uncertain || reviewer.pending || reviewer.confirmed || reviewer.uncertain); }, [onRetentionChange, state.pending, state.uncertain, state.publicationPending, prompt.pending, prompt.confirmed, prompt.uncertain, reviewer.pending, reviewer.confirmed, reviewer.uncertain]);
  return <div ref={navigation.owner}>
    <section className="worker-section" id={`${id}-panel-configuration`} data-worker-panel="configuration" role="tabpanel" aria-labelledby={`${id}-tab-configuration`} hidden={section !== 'configuration'} inert={section !== 'configuration'} onFocusCapture={event => navigation.rememberFocus('configuration', event)}>
      <WorkerConfigurationPanel workerId={workerId} {...(platform === undefined ? {} : { platform })} visible={section === 'configuration'} readEnabled={configurationRead} online={online} tasks={tasks} {...(toolPaths === undefined ? {} : { toolPaths })} {...(section === 'configuration' && onRevealToolPaths !== undefined && !navigation.confirming ? { onRevealToolPaths } : {})} state={{ ...state, setDraft: update => state.setDraft(old => { const next = typeof update === 'function' ? update(old) : update; if (!configurationDraftsEqual(old, next)) navigation.markEdited('configuration'); return next; }) }} confirming={navigation.confirming} />
    </section>
    <section className="worker-section" id={`${id}-panel-prompt`} data-worker-panel="prompt" role="tabpanel" aria-labelledby={`${id}-tab-prompt`} hidden={section !== 'prompt'} inert={section !== 'prompt'} onFocusCapture={event => navigation.rememberFocus('prompt', event)}>
      <WorkerPromptEditor state={{ ...selectedPrompt, edit: text => { if (text !== selectedPrompt.draft) navigation.markEdited('prompt'); selectedPrompt.edit(text); } }} scope="worker" purpose={purpose} onPurposeChange={setPurpose} />
    </section>
    {navigation.confirmation}
  </div>;
};
