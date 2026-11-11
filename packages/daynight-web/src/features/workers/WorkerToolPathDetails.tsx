import { useState } from 'react';
import type { WorkerConfigurationResource } from '../../api/worker-configuration';
import type { Tool, ToolContext, ToolPathActual, ToolPathChoice, ToolPathObservation, ToolPathTelemetry } from '../../api/worker-tool-paths';
import { useI18n } from '../../i18n/LocaleProvider';
import { WorkerTimestamp } from './presentation';
import { toolPathApplicationState, toolPathContexts, type ToolPathApplicationState } from './tool-path-presentation';
import './tool-paths.css';

type Props = { readonly tool: Tool; readonly telemetry?: ToolPathTelemetry; readonly desired?: WorkerConfigurationResource['desired']; readonly online: boolean | null; readonly primaryContext?: ToolContext };

const PathValue = ({ label, value }: { readonly label: string; readonly value: string }) => {
  const { messages: { workers: { configuration: { toolPaths: m } } } } = useI18n();
  const [copy, setCopy] = useState<{ value: string; state: 'copied' | 'failed' } | null>(null);
  const copyPath = async () => {
    try { await navigator.clipboard.writeText(value); setCopy({ value, state: 'copied' }); }
    catch { setCopy({ value, state: 'failed' }); }
  };
  return <details className="worker-tool-path-value"><summary>{label}</summary><div className="worker-tool-path-content">
    <code>{value}</code><button className="button quiet" type="button" aria-label={m.copyPath({ label })} onClick={() => void copyPath()}>{copy?.value === value && copy.state === 'copied' ? m.copied : m.copy}</button>
    {copy?.value === value && copy.state === 'failed' && <p className="worker-tool-error" role="status">{m.copyFailed}</p>}
  </div></details>;
};

const ChoiceValue = ({ choice, label }: { readonly choice: ToolPathChoice | null; readonly label: string }) => {
  const { messages: { workers: { configuration: { toolPaths: m } } } } = useI18n();
  return choice?.kind === 'path' ? <PathValue label={label} value={choice.path} /> : <p className="worker-tool-target"><span>{label}: </span>{choice === null ? m.awaitingImport : m.auto}</p>;
};

const ActualSelection = ({ actual, label, role }: { readonly actual: ToolPathActual; readonly label: string; readonly role: 'actual' | 'candidate' | 'active' }) => {
  const { messages: { workers: { configuration: { toolPaths: m } } } } = useI18n();
  return <div className="worker-tool-actual" data-selection-role={role}>
    <p className="worker-tool-selection-heading">{label}</p><p className="worker-tool-facts"><span className="worker-software-version">{actual.version}</span><span>{m.source[actual.source]}</span></p>
    <PathValue label={m.entryPath} value={actual.entryPath} />
    <PathValue label={m.executablePath} value={actual.executablePath} />
    {actual.interpreterPath !== null && <PathValue label={m.interpreterPath} value={actual.interpreterPath} />}
    <p className="worker-tool-time">{m.checkedAt}: <WorkerTimestamp value={actual.checkedAt} /></p>
  </div>;
};

const StateBadge = ({ state }: { readonly state: ToolPathApplicationState }) => {
  const { messages: { workers: { configuration: { toolPaths: m } } } } = useI18n();
  return <span className={`worker-tool-state ${state}`}>{m.state[state]}</span>;
};

const ContextDetails = ({ tool, context, entry, desired, online }: { readonly tool: Tool; readonly context: ToolContext; readonly entry: ToolPathObservation | undefined; readonly desired: Props['desired']; readonly online: boolean | null }) => {
  const { messages: { workers: { configuration: { toolPaths: m } } }, format } = useI18n();
  const state = toolPathApplicationState(entry, desired, online);
  const currentTarget = desired?.value.toolPaths?.[tool];
  const target = currentTarget === undefined ? entry?.target : currentTarget;
  const count = (value: number | null) => value === null ? m.unknownCount : format.number(value);
  return <section className="worker-tool-context" data-context={context} aria-label={`${tool === 'codex' ? 'Codex' : tool === 'copilot' ? 'Copilot' : 'Herdr'} ${context === 'web' ? 'Web' : 'Herdr'}`}>
    <div className="worker-tool-context-heading"><span>{context === 'web' ? 'Web' : 'Herdr'}</span><StateBadge state={state} /></div>
    {target !== undefined && <ChoiceValue choice={target} label={currentTarget === undefined ? m.reportedTarget : m.target} />}
    {entry !== undefined && <>
      <p className="worker-tool-source">{m.configurationSource[entry.configurationSource]}</p>
      {entry.error !== null && <p className="worker-tool-error">{m.error[entry.error.code]} <WorkerTimestamp value={entry.error.occurredAt} /></p>}
      {entry.reason !== null && <p className="worker-tool-reason">{m.reason[entry.reason]}</p>}
      {entry.actual === null ? <p className="worker-tool-empty">{m.noActual}</p> : <ActualSelection role="actual" actual={entry.actual} label={state === 'applied' ? m.actual : desired == null ? m.reportedActual : m.previousActual} />}
      {entry.candidate !== null && <ActualSelection role="candidate" actual={entry.candidate} label={m.candidate} />}
      {(entry.activeSelections.length > 0 || !entry.activeSelectionsComplete) && <div className="worker-tool-active">
        <p className="worker-tool-selection-heading">{m.active}{entry.activeSelectionCount !== null && <> · {m.activeCount({ count: format.number(entry.activeSelectionCount) })}</>}</p>
        {entry.activeSelections.map(group => <div className="worker-tool-active-group" key={group.actual.selectionKey}>
          <ActualSelection role="active" actual={group.actual} label={m.active} />
          <p className="worker-tool-facts"><span>{m.executionCount({ count: count(group.executionCount) })}</span><span>{m.instanceCount({ count: count(group.instanceCount) })}</span>{group.unconfirmedCount > 0 && <span>{m.unconfirmedCount({ count: format.number(group.unconfirmedCount) })}</span>}</p>
        </div>)}
        {!entry.activeSelectionsComplete && <p className="worker-tool-reason">{m.incomplete}</p>}
        {entry.activeObservationError !== null && <p className="worker-tool-reason">{m.activeError[entry.activeObservationError]}</p>}
      </div>}
    </>}
  </section>;
};

export const WorkerToolPathDetails = ({ tool, telemetry, desired, online, primaryContext }: Props) => {
  const { messages: { workers: { configuration: { toolPaths: m } } } } = useI18n();
  const contexts = toolPathContexts(tool, primaryContext);
  return <div className="worker-tool-path-details" data-tool={tool}>
    {telemetry === undefined ? <p className="worker-tool-empty">{m.unsupportedWorker}</p> : <>
      {contexts.map((context, index) => {
        const entry = telemetry.entries.find(item => item.tool === tool && item.context === context);
        const content = <ContextDetails tool={tool} context={context} entry={entry} desired={desired} online={online} />;
        return index === 0 ? <div key={context}>{content}</div> : <details className="worker-tool-other-context" key={context}><summary>{m.otherContext}: {context === 'web' ? 'Web' : 'Herdr'}</summary>{content}</details>;
      })}
      <p className="worker-tool-time">{m.reportedAt}: <WorkerTimestamp value={telemetry.observedAt} /></p>
    </>}
  </div>;
};
