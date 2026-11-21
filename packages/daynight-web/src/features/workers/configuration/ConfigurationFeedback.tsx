import type { WorkerConfigurationKey, WorkerConfigurationOutcome, WorkerConfigurationResource } from '../../../api/worker-configuration';
import { useI18n } from '../../../i18n/LocaleProvider';
import { WorkerTimestamp } from '../presentation';
import type { WorkerTaskTagFilter } from '../../../api/worker-task-tag-filter';
import { TaskTagFilterValue } from './TaskTagFilterValue';
import type { TaskTagDigest } from './useTaskTagFilterObservation';

export const configurationOutcome = (resource: WorkerConfigurationResource, kind: WorkerConfigurationKey['kind'], projectId?: string): WorkerConfigurationOutcome | undefined =>
  resource.observation?.items.find(item => item.key.kind === kind && ('projectId' in item.key ? item.key.projectId === projectId : projectId === undefined));

export const configurationOutcomeState = (resource: WorkerConfigurationResource, item: WorkerConfigurationOutcome | undefined, expected: WorkerConfigurationOutcome['appliedValue']): WorkerConfigurationOutcome['state'] => {
  if (item === undefined) return 'pending';
  if (item.key.kind === 'projectRemoval') return item.state;
  if (item.key.kind === 'agentControlMode' && resource.desired !== null && resource.observation !== null && BigInt(resource.observation.desiredRevision) < BigInt(resource.desired.revision)) return 'pending';
  if ('projectId' in item.key) {
    const projectId = item.key.projectId;
    const removal = configurationOutcome(resource, 'projectRemoval', projectId);
    if (removal !== undefined && BigInt(removal.targetRevision) >= BigInt(item.targetRevision)) return 'pending';
    if (resource.desired !== null && resource.observation !== null && BigInt(resource.observation.desiredRevision) < BigInt(resource.desired.revision)) return 'pending';
  }
  const matches = JSON.stringify(item.appliedValue) === JSON.stringify(expected);
  if (item.state === 'applied') return matches && item.appliedValue !== null ? 'applied' : 'pending';
  if (resource.desired !== null && resource.observation !== null && BigInt(resource.observation.desiredRevision) < BigInt(resource.desired.revision)) return 'pending';
  return item.state;
};

export const ConfigurationFeedback = ({ resource, kind, projectId, expected, changed = false, label = false, id }: {
  readonly resource: WorkerConfigurationResource;
  readonly kind: WorkerConfigurationKey['kind'];
  readonly projectId?: string;
  readonly expected: WorkerConfigurationOutcome['appliedValue'];
  readonly changed?: boolean;
  readonly label?: boolean;
  readonly id?: string;
}) => {
  const { messages: { workers: { configuration: m } } } = useI18n();
  const item = configurationOutcome(resource, kind, projectId);
  const actualState = configurationOutcomeState(resource, item, expected);
  const state = changed ? 'unsaved' : actualState;
  const value = item?.appliedValue;
  const rendered = kind === 'taskTagFilter' ? m.unavailableValue : value === undefined || value === null ? m.unavailableValue : typeof value === 'number' || typeof value === 'string' ? String(value)
    : typeof value === 'boolean' ? (kind === 'preferPlatformSpecificTasks' || kind === 'archiveSessions' || kind === 'enableSudoCleanup' || kind === 'enableWindowsProcessCleanup') ? value ? m.enabled : m.disabled : m.state.applied : `${value.agent === 'claude' ? 'Claude Code' : value.agent === 'copilot' ? 'Copilot' : 'Codex'} / ${value.model === null ? m.defaultModel : value.model} / ${JSON.stringify(value.args)}`;
  const previousFailure = item?.lastFailure ?? (actualState === 'pending' ? item?.error : null);
  return <div id={id} className="application-feedback">
    {label && <span className="configuration-result-label">{m.kind[kind]}</span>}
    <span className={`status-chip ${state}`}>{m.state[state]}</span>
    <span className="current-value">{m.actual}: {rendered}</span>
    {item !== undefined && <span className="configuration-item-version">{m.targetVersion} {item.targetRevision}</span>}
    {item?.error !== null && item?.error !== undefined && actualState === 'error' && <span className="field-error">{m.phases[item.error.phase]} · {m.codes[item.error.code]} · <WorkerTimestamp value={item.error.occurredAt} /></span>}
    {previousFailure !== null && previousFailure !== undefined && (item?.error === null || actualState !== 'error') && <span className="configuration-last-failure">{m.lastFailure}: {m.phases[previousFailure.phase]} · {m.codes[previousFailure.code]} · <WorkerTimestamp value={previousFailure.occurredAt} /></span>}
    {item?.nextAttemptAt !== null && item?.nextAttemptAt !== undefined && <span className="configuration-retry">{m.nextAttempt}: <WorkerTimestamp value={item.nextAttemptAt} /></span>}
  </div>;
};

export const taskTagApplicationState = (resource: WorkerConfigurationResource, digest: TaskTagDigest): WorkerConfigurationOutcome['state'] => {
  const item = configurationOutcome(resource, 'taskTagFilter');
  if (item?.state === 'error') return 'error';
  if (digest.state === 'error') return 'error';
  if (digest.state !== 'ready') return 'pending';
  return configurationOutcomeState(resource, item, digest.digest);
};

export const ConfigurationTaskTagFeedback = ({ resource, filter, digest, changed = false }: { readonly resource: WorkerConfigurationResource; readonly filter: WorkerTaskTagFilter; readonly digest: TaskTagDigest; readonly changed?: boolean }) => {
  const { messages: { workers: { configuration: m } } } = useI18n();
  const item = configurationOutcome(resource, 'taskTagFilter');
  const state = item === undefined ? 'pending' : item.state !== 'applied' ? item.state : digest.state === 'ready' ? configurationOutcomeState(resource, item, digest.digest) : 'pending';
  const actual = item?.appliedValue == null ? m.unavailableValue : digest.state !== 'ready' ? m.unavailableValue : item.appliedValue === digest.digest ? <TaskTagFilterValue filter={filter} /> : m.taskTags.different;
  return <div className="application-feedback" aria-live="polite">
    <span className={`status-chip ${changed ? 'unsaved' : state}`}>{changed ? m.state.unsaved : item === undefined ? m.taskTags.unconfirmed : m.state[state]}</span>
    {digest.state !== 'ready' && <span className={digest.state === 'error' ? 'field-error' : ''}>{digest.state === 'checking' ? m.taskTags.checking : m.taskTags.checkFailed}</span>}
    <span className="current-value">{m.actual}: {actual}</span>
    {item !== undefined && <span className="configuration-item-version">{m.targetVersion} {item.targetRevision}</span>}
    {item?.error != null && <span className="field-error">{m.phases[item.error.phase]} · {m.codes[item.error.code]} · <WorkerTimestamp value={item.error.occurredAt} /></span>}
    {item?.lastFailure != null && item.error === null && <span className="configuration-last-failure">{m.lastFailure}: {m.phases[item.lastFailure.phase]} · {m.codes[item.lastFailure.code]} · <WorkerTimestamp value={item.lastFailure.occurredAt} /></span>}
    {item?.nextAttemptAt != null && <span className="configuration-retry">{m.nextAttempt}: <WorkerTimestamp value={item.nextAttemptAt} /></span>}
  </div>;
};
