import { useLayoutEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../../api/client';
import { configurationValueSourcesEqual } from '../../../api/configuration-source';
import { jsonContainerSources, jsonObjectSources } from '../../../api/json-source';
import { workerConfigurationBaseline } from '../../../api/worker-configuration';
import type { WorkerConfigurationResource, WorkerConfigurationOutcome } from '../../../api/worker-configuration';
import type { WorkerTaskSnapshot } from '../../../api/workers';
import type { ToolPathTelemetry } from '../../../api/worker-tool-paths';
import type { ExecutionPlatform } from '../../../api/types';
import { useI18n } from '../../../i18n/LocaleProvider';
import { useTaskCacheScope } from '../../task-cache/TaskCacheProvider';
import { WorkerTimestamp } from '../presentation';
import { ConfigurationFeedback, configurationOutcome, configurationOutcomeState, taskTagApplicationState } from './ConfigurationFeedback';
import { ConfigurationTaskTagsField } from './ConfigurationTaskTagsField';
import { ConfigurationToolPathsFields } from './ConfigurationToolPathsFields';
import { allToolPathsApplied, toolPathSummaryStates } from '../tool-path-presentation';
import { ConfigurationFieldError, ConfigurationNativeFields, ConfigurationProjectNativeFields } from './ConfigurationNativeFields';
import { ConfigurationProjectsDialog, ConfigurationRemovalDialog } from './ConfigurationDialogs';
import { configurationFieldChanges, emptyProjectDraft, parseConfigurationDraft, resolvedProjectNative, type ConfigurationDraft } from './model';
import { useConfigurationProjects } from './useConfigurationProjects';
import { TaskCacheError } from '../../task-cache/database';
import { useWorkerConfiguration } from './useWorkerConfiguration';
import { useConfigurationFormScroll } from './useConfigurationFormScroll';
import { useTaskTagFilterObservation, type TaskTagDigest } from './useTaskTagFilterObservation';
import './configuration.css';

const agentName = (agent: string) => agent === 'claude' ? 'Claude Code' : agent === 'copilot' ? 'Copilot' : 'Codex';
const globalFields = ['maxConcurrent', 'pollIntervalMs', 'recoveryLimit'] as const;

const hasUnknownApplication = (resource: WorkerConfigurationResource): boolean => {
  const baseline = workerConfigurationBaseline(resource);
  if (baseline !== null && !configurationValueSourcesEqual(baseline.valueSource, JSON.stringify(baseline.known))) return true;
  const observation = resource.observation;
  if (observation?.document === undefined) return false;
  const raw = jsonObjectSources(observation.document.source).get('observation');
  const items = raw === undefined ? undefined : jsonObjectSources(raw).get('items');
  if (items === undefined) return false;
  const sources = jsonContainerSources(items);
  if (sources.length !== observation.items.length) return true;
  return sources.some((source, index) => {
    const known = observation.items[index]!;
    if ('projectId' in known.key) {
      const fields = new Map(jsonObjectSources(source));
      const key = new Map(jsonObjectSources(fields.get('key')!));
      key.set('projectId', JSON.stringify(known.key.projectId));
      fields.set('key', `{${[...key].map(([name, value]) => `${JSON.stringify(name)}:${value}`).join(',')}}`);
      source = `{${[...fields].map(([name, value]) => `${JSON.stringify(name)}:${value}`).join(',')}}`;
    }
    return !configurationValueSourcesEqual(`{"item":${source}}`, JSON.stringify({ item: known }));
  });
};

const applicationStates = (resource: WorkerConfigurationResource, tagDigest: TaskTagDigest): readonly WorkerConfigurationOutcome['state'][] => {
  if (resource.desired === null) return [];
  const { value } = resource.desired;
  const states = [...globalFields, 'preferPlatformSpecificTasks' as const, 'native' as const].map(kind => configurationOutcomeState(resource, configurationOutcome(resource, kind), value[kind]));
  if (value.taskTagFilter !== undefined) states.push(taskTagApplicationState(resource, tagDigest));
  if (value.enableSudoCleanup !== undefined) states.push(configurationOutcomeState(resource, configurationOutcome(resource, 'enableSudoCleanup'), value.enableSudoCleanup));
  if (resource.archiveSessionsSupported === true) states.push(configurationOutcomeState(resource, configurationOutcome(resource, 'archiveSessions'), value.archiveSessions ?? null));
  for (const project of value.projects) {
    states.push(configurationOutcomeState(resource, configurationOutcome(resource, 'projectPreparation', project.projectId), true));
    states.push(configurationOutcomeState(resource, configurationOutcome(resource, 'projectNative', project.projectId), resolvedProjectNative(value.native, project.nativeOverrides)));
  }
  const selected = new Set(value.projects.map(project => project.projectId));
  for (const item of resource.observation?.items ?? []) {
    if (item.key.kind === 'projectRemoval' && (!selected.has(item.key.projectId) || item.state !== 'applied')) states.push(item.state);
  }
  if (resource.observation === null || BigInt(resource.observation.desiredRevision) < BigInt(resource.desired.revision) || hasUnknownApplication(resource)) states.push('pending');
  return states;
};

const ConfigurationSummary = ({ resource, online, toolPaths, tagDigest }: { readonly resource: WorkerConfigurationResource; readonly online: boolean | null; readonly toolPaths: ToolPathTelemetry | undefined; readonly tagDigest: TaskTagDigest }) => {
  const { messages: { workers: { configuration: m } } } = useI18n();
  const states = useMemo(() => applicationStates(resource, tagDigest), [resource, tagDigest]);
  const failed = states.includes('error');
  const tools = toolPathSummaryStates(resource, toolPaths, online);
  const toolsApplied = resource.toolPathsSupported !== true || tools.length > 0 && tools.every(state => state === 'applied');
  const allToolsApplied = allToolPathsApplied(resource, toolPaths, online);
  const status = failed ? states.includes('applied') ? m.partialFailure : m.state.error : states.length > 0 && states.every(state => state === 'applied') && allToolsApplied && online === true ? m.allApplied : m.applying;
  return <aside className="configuration-aside"><section className="worker-panel summary-panel"><h2 className="worker-panel-heading">{m.summary}</h2><dl className="configuration-summary">
    <div><dt>{m.targetVersion}</dt><dd>{resource.desired?.revision}</dd></div>
    <div><dt>{m.updatedAt}</dt><dd>{resource.desired !== null && <WorkerTimestamp value={resource.desired.updatedAt} />}</dd></div>
    <div><dt>{m.application}</dt><dd aria-live="polite"><span className={`status-chip ${failed ? 'error' : status === m.allApplied ? 'applied' : 'pending'}`}>{status}</span></dd></div>
    {resource.toolPathsSupported === true && <div><dt>{m.toolPaths.title} · Codex / Copilot</dt><dd>{online !== true ? m.toolPaths.state[online === false ? 'offline' : 'unconfirmed'] : tools.includes('error') ? m.partialFailure : toolsApplied ? m.toolPaths.state.applied : m.toolPaths.state.not_checked}</dd></div>}
    <div><dt>{m.reportedAt}</dt><dd>{resource.observation === null ? m.awaitingReport : <WorkerTimestamp value={resource.observation.reportedAt} />}</dd></div>
    <div><dt>{m.workerConnection}</dt><dd>{online === null ? m.noRecentReport : online ? m.online : m.offline}</dd></div>
  </dl></section><details className="local-settings"><summary>{m.localSettings}</summary><p>{m.localSettingsDetail}</p><ul>{m.localSettingsItems.map(item => <li key={item}>{item}</li>)}</ul></details></aside>;
};

const ConfigurationError = ({ error, write, retained }: { readonly error: unknown; readonly write: boolean; readonly retained: boolean }) => {
  const { messages: { workers: { configuration: m }, common } } = useI18n();
  const detail = error instanceof ApiError ? error.kind === 'server' && error.code === 'worker_task_tag_filter_unsupported' ? m.taskTags.unsupportedWorker : error.kind === 'server' && error.code === 'invalid_input' && error.serverMessage === 'Unsupported Worker tool paths protocol.' ? m.toolPaths.unsupportedService : error.kind === 'network' ? m.networkError : error.kind === 'protocol' ? error.code === 'worker_tool_paths_upgrade' ? m.toolPaths.unsupportedService : m.protocolError : error.status === 403 ? m.permissionError : retained ? m.retainedDraft : null : retained ? m.retainedDraft : null;
  return <><p className="notice-heading">{write ? m.saveFailed : m.readFailed}</p>{detail !== null && <p>{detail}</p>}
    {error instanceof ApiError && error.requestId !== null && <p className="request-id">{common.requestId} <code>{error.requestId}</code></p>}</>;
};

export const WorkerConfigurationPanel = ({ workerId, platform, visible, readEnabled, online, tasks, toolPaths, onRevealToolPaths, state, confirming }: {
  readonly onRevealToolPaths?: () => void;
  readonly workerId: string;
  readonly platform?: ExecutionPlatform;
  readonly visible: boolean;
  readonly readEnabled: boolean;
  readonly online: boolean | null;
  readonly tasks: readonly WorkerTaskSnapshot[];
  readonly toolPaths?: ToolPathTelemetry;
  readonly state: ReturnType<typeof useWorkerConfiguration>;
  readonly confirming: boolean;
}) => {
  const toolPathsEditable = toolPaths !== undefined;
  const choices = useConfigurationProjects(readEnabled);
  const { messages: { workers: { configuration: m }, workers, platform: platformMessages }, format } = useI18n();
  const scope = useTaskCacheScope();
  const [dialog, setDialog] = useState<'projects' | 'removal' | null>(null);
  const [tagError, setTagError] = useState(false);
  useLayoutEffect(() => { if (confirming) setDialog(null); }, [confirming]);
  useLayoutEffect(() => { setDialog(null); setTagError(false); }, [workerId, scope]);
  useLayoutEffect(() => { if (!visible) setDialog(null); }, [visible]);
  useLayoutEffect(() => { if (state.unavailable || state.resource !== null && state.resource.desired === null) setDialog(null); }, [state.unavailable, state.resource]);
  const { resource, draft } = state;
  const tagDigest = useTaskTagFilterObservation(scope, workerId, resource?.desired?.value.taskTagFilter);
  const formRef = useConfigurationFormScroll(state.dirty && visible, draft);
  const disabled = state.unavailable;
  const actionsDisabled = !readEnabled || disabled;
  const metadata = new Map(choices.items.map(project => [project.id, project]));
  const shell = (content: ReactNode) => <div className="worker-configuration">{content}</div>;
  if (state.unavailable) return shell(<section className="state-box" role="status"><h2>{m.unavailable}</h2><button className="button" type="button" disabled={!readEnabled || state.refreshing} onClick={state.refresh}>{workers.retry}</button></section>);
  if (resource === null) return shell(<section className="state-box" role={state.error === null ? 'status' : 'alert'}>{state.loading ? <><span className="spinner" aria-hidden="true" /><h2>{m.loading}</h2></> : <ConfigurationError error={state.error} write={false} retained={false} />}{state.error !== null && <button className="button" type="button" disabled={!readEnabled || state.refreshing} onClick={state.refresh}>{workers.retry}</button>}</section>);
  if (resource.desired === null || draft === null) return shell(<section className="state-box" role="status"><h2>{m.uninitialized}</h2><p>{m.uninitializedDetail}</p><button className="button" type="button" disabled={!readEnabled || state.refreshing} onClick={state.refresh}>{state.refreshing ? workers.refreshing : workers.refresh}</button></section>);
  const source = workerConfigurationBaseline(resource)?.valueSource;
  const desired = resource.desired, parsed = parseConfigurationDraft(draft, resource.controlModeSupported === true, { toolPathsSupported: resource.toolPathsSupported === true && toolPathsEditable, ...(platform === undefined ? {} : { platform }) }), changed = configurationFieldChanges(draft, state.comparisonValue ?? desired.value, parsed.errors);
  const tagInvalid = parsed.errors.taskTagFilter !== undefined;
  const tagEditable = configurationOutcome(resource, 'taskTagFilter') !== undefined;
  const onlyUnavailableTagInvalid = tagInvalid && !tagEditable && Object.keys(parsed.errors).every(key => key === 'taskTagFilter');
  const removed = desired.value.projects.filter(project => !draft.projects.some(selected => selected.projectId === project.projectId)).map(project => ({ projectId: project.projectId, name: metadata.get(project.projectId)?.name ?? project.projectId }));
  const removals = resource.observation?.items.filter(item => item.key.kind === 'projectRemoval') ?? [];
  const updateProject = (projectId: string, value: ConfigurationDraft['projects'][number]['native']) => state.setDraft(old => ({ ...old, projects: old.projects.map(project => project.projectId === projectId ? { ...project, native: value } : project) }));
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (actionsDisabled || state.pending || state.uncertain || state.publicationPending || state.notice === 'conflict' || state.conflict) return;
    if (tagInvalid && tagEditable) { setTagError(true); document.getElementById('config-taskTagFilter')?.focus(); return; }
    if (parsed.value === null && !onlyUnavailableTagInvalid || !state.saveableDirty) return;
    if (removed.length > 0) setDialog('removal');
    else void state.save();
  };
  const chooseProjects = () => { choices.refresh(); setDialog('projects'); };
  return shell(<>
    {state.unsupportedFields.length > 0 && <div className="notice warning configuration-notice" role="status"><p className="notice-heading">{m.unsupportedFields}</p><p>{m.unsupportedFieldsDetail}</p><p>{state.unsupportedFields.map((field, index) => <span key={field}>{index > 0 && ', '}<code>{field}</code></span>)}</p></div>}
    {source !== undefined && <details className="configuration-source"><summary>{m.savedSource}</summary><p>{m.sourceProjection}</p><pre>{source}</pre></details>}
    {online === false && <div className="notice warning configuration-notice" role="status">{m.offlineNotice}</div>}
    {state.conflict || state.notice === 'conflict' ? <div className="notice warning configuration-notice" role="alert"><p className="notice-heading">{m.conflict}</p><p>{m.retainedDraft}</p>{state.conflict && source !== undefined && <details><summary>{m.viewLatest}</summary><p>{m.sourceProjection}</p><pre>{source}</pre></details>}<div className="notice-actions"><button className="button" type="button" disabled={disabled || state.pending || state.uncertain || state.publicationPending || state.notice === 'conflict' && !state.conflict} onClick={() => { setTagError(false); state.loadLatest(); }}>{m.loadLatest}</button></div></div> : null}
    {state.uncertain && <div className="notice warning configuration-notice" role="alert"><p>{m.uncertain}</p><button className="button" type="button" disabled={!readEnabled || state.refreshing} onClick={state.refresh}>{m.verifySave}</button></div>}
    {state.error !== null && !state.uncertain && <div className="notice error configuration-notice" role="alert"><ConfigurationError error={state.error} write={state.errorSource === 'write'} retained /><button className="button" type="button" disabled={!readEnabled || state.refreshing || state.pending} onClick={state.refresh}>{workers.retry}</button></div>}
    {choices.error !== null && <div className="notice error configuration-notice" role="alert"><p>{choices.error instanceof TaskCacheError ? workers.cacheStorageError : m.projectsFailed}</p><button className="button" type="button" disabled={!readEnabled || choices.loading} onClick={choices.refresh}>{workers.retry}</button></div>}
    {state.notice === 'saved' || state.notice === 'reconciled' || state.notice === 'notSaved' ? <div className={`notice ${state.notice === 'notSaved' ? 'warning' : 'success'} configuration-notice`} role="status">{m[state.notice]}</div> : null}
    <div className="configuration-layout"><div className="configuration-main"><form ref={formRef} className={state.dirty ? 'configuration-form is-dirty' : 'configuration-form'} onSubmit={save} noValidate aria-label={m.configuration}>
      <section className="panel config-panel"><header className="panel-heading"><h2>{m.settings}</h2><button className="button" type="button" disabled={!readEnabled || state.refreshing || state.pending} onClick={state.refresh}>{state.refreshing ? workers.refreshing : workers.refresh}</button></header><div className="panel-body config-grid">{globalFields.map(key => <div className="field" key={key}><label htmlFor={`config-${key}`}>{m[key]}</label><div className="field-unit"><input id={`config-${key}`} type="text" inputMode="numeric" value={draft[key]} disabled={disabled} aria-invalid={parsed.errors[key] !== undefined} aria-describedby={`feedback-${key}${parsed.errors[key] === undefined ? '' : ` config-${key}-error`}`} onChange={event => state.setDraft(old => ({ ...old, [key]: event.target.value }))} />{key === 'pollIntervalMs' && <span>{m.milliseconds}</span>}</div><ConfigurationFieldError issue={parsed.errors[key]} id={`config-${key}-error`} range={{ minimum: key === 'recoveryLimit' ? 0 : 1, maximum: key === 'pollIntervalMs' ? 2_147_483_647 : Number.MAX_SAFE_INTEGER }} /><ConfigurationFeedback id={`feedback-${key}`} resource={resource} kind={key} expected={desired.value[key]} changed={changed[key]} /></div>)}<div className="field full"><label className="configuration-toggle" htmlFor="config-preferPlatformSpecificTasks"><input id="config-preferPlatformSpecificTasks" type="checkbox" checked={draft.preferPlatformSpecificTasks} disabled={disabled} aria-describedby="platform-preference-detail feedback-preferPlatformSpecificTasks" onChange={event => state.setDraft(old => ({ ...old, preferPlatformSpecificTasks: event.target.checked }))} /><span>{platform === undefined ? m.preferPlatformSpecificTasks : m.preferPlatformTasks({ platform: platformMessages.names[platform] })}</span></label><p className="configuration-toggle-detail" id="platform-preference-detail">{m.platformPreferenceDetail}</p><ConfigurationFeedback id="feedback-preferPlatformSpecificTasks" resource={resource} kind="preferPlatformSpecificTasks" expected={desired.value.preferPlatformSpecificTasks} changed={changed.preferPlatformSpecificTasks} /></div><ConfigurationTaskTagsField resource={resource} digest={tagDigest} draft={draft.taskTagFilter} disabled={disabled} invalid={tagError} changed={changed.taskTagFilter} onChange={value => { setTagError(false); state.setDraft(old => ({ ...old, taskTagFilter: value })); }} />
      <div className="field full">{resource.archiveSessionsSupported === true && draft.archiveSessions !== undefined ? <><label className="configuration-toggle" htmlFor="config-archiveSessions"><input id="config-archiveSessions" type="checkbox" checked={draft.archiveSessions} disabled={disabled || configurationOutcome(resource, 'archiveSessions') === undefined} aria-describedby={`archive-sessions-detail feedback-archiveSessions${configurationOutcome(resource, 'archiveSessions') === undefined ? ' archive-sessions-availability' : ''}`} onChange={event => state.setDraft(old => ({ ...old, archiveSessions: event.target.checked }))} /><span>{m.archiveSessions}</span></label><p className="configuration-toggle-detail" id="archive-sessions-detail">{m.archiveSessionsDetail}</p>{configurationOutcome(resource, 'archiveSessions') === undefined && <p className="configuration-toggle-detail" id="archive-sessions-availability">{m.archiveSessionsUnsupportedWorker}</p>}<ConfigurationFeedback id="feedback-archiveSessions" resource={resource} kind="archiveSessions" expected={desired.value.archiveSessions ?? null} changed={changed.archiveSessions} /></> : <p className="configuration-toggle-detail">{m.archiveSessionsUnsupportedService}</p>}</div><div className="field full"><label className="configuration-toggle" htmlFor="config-enableSudoCleanup"><input id="config-enableSudoCleanup" type="checkbox" checked={draft.enableSudoCleanup ?? false} disabled={disabled || draft.enableSudoCleanup === undefined || (platform !== 'linux' && platform !== 'macos')} aria-describedby={`sudo-cleanup-detail sudo-cleanup-availability${desired.value.enableSudoCleanup === undefined ? '' : ' feedback-enableSudoCleanup'}`} onChange={event => state.setDraft(old => ({ ...old, enableSudoCleanup: event.target.checked }))} /><span>{m.enableSudoCleanup}</span></label><p className="configuration-toggle-detail" id="sudo-cleanup-detail">{m.enableSudoCleanupDetail}</p><p className="configuration-toggle-detail" id="sudo-cleanup-availability">{draft.enableSudoCleanup === undefined ? m.sudoCleanupUnsupportedService : platform === 'windows' ? m.sudoCleanupUnsupportedPlatform : platform === undefined ? m.sudoCleanupUnknownPlatform : ''}</p>{desired.value.enableSudoCleanup !== undefined && <ConfigurationFeedback id="feedback-enableSudoCleanup" resource={resource} kind="enableSudoCleanup" expected={desired.value.enableSudoCleanup} changed={changed.enableSudoCleanup} />}</div></div></section>
      <section className="panel config-panel"><header className="panel-heading"><h2>{m.defaultNative}</h2></header><div className="panel-body config-grid"><ConfigurationNativeFields value={draft.native} onChange={native => state.setDraft(old => ({ ...old, native }))} disabled={disabled} errors={parsed.errors} /><div className="native-summary"><ConfigurationFeedback resource={resource} kind="native" expected={desired.value.native} changed={changed.native} /></div></div></section>
      <ConfigurationToolPathsFields key={workerId} {...(onRevealToolPaths === undefined ? {} : { onRevealToolPaths })} resource={resource} value={draft.toolPaths} telemetry={toolPaths} online={online} disabled={disabled} changed={changed.toolPaths} errors={parsed.errors}
        onChange={(tool, choice) => state.setDraft(old => ({ ...old, toolPaths: { codex: null, copilot: null, ...old.toolPaths, [tool]: choice } }))} />
      <section className="panel config-panel"><header className="panel-heading"><h2>{m.projects} <span className="worker-count-badge">{format.number(draft.projects.length)}</span></h2><button className="button" type="button" disabled={disabled} onClick={chooseProjects}>＋ {m.chooseProjects}</button></header>
        {draft.projects.length === 0 ? <div className="empty-projects"><p>{m.noProjects}</p><button className="button" type="button" disabled={disabled} onClick={chooseProjects}>{m.chooseProjects}</button></div> : <div className="project-config-list">{draft.projects.map(project => {
          const meta = metadata.get(project.projectId), name = meta?.name ?? project.projectId;
          const selected = desired.value.projects.find(item => item.projectId === project.projectId);
          const resolved = parsed.value === null ? null : resolvedProjectNative(parsed.value.native, parsed.value.projects.find(item => item.projectId === project.projectId)!.nativeOverrides);
          const inherited = project.native.agent === 'inherit' && project.native.modelMode === 'inherit' && project.native.argsMode === 'inherit';
          return <article className="project-config-item" key={project.projectId}><div className="project-config-heading"><div className="project-config-identity"><span className="project-config-icon" aria-hidden="true">▦</span><div><h3>{name}</h3><p>{meta?.repoUrl ?? m.inaccessible}</p></div></div><button className="button quiet" type="button" disabled={disabled} aria-label={m.removeProject({ name })} onClick={() => state.setDraft(old => ({ ...old, projects: old.projects.filter(item => item.projectId !== project.projectId) }))}>{m.remove}</button></div>
            <ConfigurationFeedback label resource={resource} kind="projectPreparation" projectId={project.projectId} expected={true} changed={selected === undefined} />
            <ConfigurationFeedback label resource={resource} kind="projectNative" projectId={project.projectId} expected={selected === undefined ? null : resolvedProjectNative(desired.value.native, selected.nativeOverrides)} changed={changed.projects.get(project.projectId) ?? true} />
            <details className="project-native"><summary>{m.projectNative} · {inherited ? m.inheritGlobal : resolved === null ? m.unavailableValue : `${agentName(resolved.agent)} / ${resolved.model === null ? m.defaultModel : resolved.model}`}{Object.keys(parsed.errors).some(key => key.startsWith(`projects.${project.projectId}.`)) && <span className="project-native-invalid"> · {m.invalidField}</span>}</summary><ConfigurationProjectNativeFields projectId={project.projectId} name={name} value={project.native} globalAgent={draft.native.agent} resolved={resolved} onChange={native => updateProject(project.projectId, native)} disabled={disabled || meta === undefined} errors={parsed.errors} /></details>
          </article>;
        })}</div>}
      </section>
      {removals.length > 0 && <section className="panel config-panel project-removal-results"><header className="panel-heading"><h2>{m.removalResults}</h2></header><div className="project-config-list">{removals.map(item => {
        if (!('projectId' in item.key)) return null;
        const projectId = item.key.projectId;
        return <article className="project-config-item" key={projectId}><div className="project-config-heading"><div className="project-config-identity"><span className="project-config-icon" aria-hidden="true">▦</span><div><h3>{metadata.get(projectId)?.name ?? projectId}</h3><p>{m.kind.projectRemoval}</p></div></div></div><ConfigurationFeedback resource={resource} kind="projectRemoval" projectId={projectId} expected={true} /></article>;
      })}</div></section>}
      <div className="config-save-slot"><footer className="config-save-bar"><span className="draft-summary" role="status">{state.dirty ? m.unsaved : m.noChanges}</span><button className="button" type="button" disabled={disabled || state.pending || state.uncertain || state.publicationPending || !state.dirty} onClick={() => { setTagError(false); state.discard(); }}>{m.discard}</button><button className="button primary" type="submit" disabled={actionsDisabled || state.pending || state.uncertain || state.publicationPending || state.notice === 'conflict' || (!state.saveableDirty && !(state.dirty && tagInvalid && tagEditable)) || (parsed.value === null && !onlyUnavailableTagInvalid && !(tagInvalid && tagEditable)) || state.conflict}>{state.pending ? m.saving : m.save}</button></footer></div>
    </form></div><ConfigurationSummary resource={resource} online={online} toolPaths={toolPaths} tagDigest={tagDigest} /></div>
    {!confirming && dialog === 'projects' && <ConfigurationProjectsDialog projects={choices.items} selected={draft.projects.map(project => project.projectId)} loading={choices.loading} error={choices.error} refresh={choices.refresh} onClose={() => setDialog(null)} onApply={ids => { state.setDraft(old => ({ ...old, projects: ids.map(id => old.projects.find(project => project.projectId === id) ?? emptyProjectDraft(id)) })); setDialog(null); }} />}
    {!confirming && dialog === 'removal' && <ConfigurationRemovalDialog disabled={actionsDisabled} projects={removed} tasks={tasks} onClose={() => setDialog(null)} onConfirm={() => { setDialog(null); void state.save(); }} />}
  </>);
};
