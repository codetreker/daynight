import { stringifyAssistantTaskJson } from '../../api/assistant-tasks';
import { useId, useState } from 'react';
import type { AssistantTask, AssistantTaskAppendix, AssistantTaskManual as Manual, AssistantTaskProposal } from '../../api/assistant-tasks';
import { AssistantTaskEvidence, AssistantTaskMarkdown } from './AssistantTaskProposalPanel';
import { useAssistantTaskContentMessages } from './assistant-task-messages';

export type AssistantTaskManualProps = {
  readonly task: AssistantTask;
  readonly manual: Manual;
  readonly appendices: readonly AssistantTaskAppendix[];
  readonly histories: readonly Manual[];
  readonly proposals: readonly AssistantTaskProposal[];
  readonly disabled: boolean;
  readonly onAppendixEdit: (entry: AssistantTaskAppendix, text: string, ifVersion: string) => Promise<boolean>;
  readonly onAppendixDelete: (entry: AssistantTaskAppendix, ifVersion: string) => Promise<boolean>;
  readonly onRollback: (version: string, ifVersion: string) => Promise<boolean>;
  readonly onMoreHistory?: () => void;
  readonly historyHasMore?: boolean;
  readonly onRecords?: (id: string) => void;
};
export function AssistantTaskManual({ task, manual, appendices, histories, proposals, disabled, onAppendixEdit, onAppendixDelete, onRollback, onMoreHistory, historyHasMore = false, onRecords }: AssistantTaskManualProps) {
  const m = useAssistantTaskContentMessages();
  const [tab, setTab] = useState<'body' | 'appendix' | 'history'>('body');
  const active = appendices.filter(entry => entry.state !== 'deleted');
  return <section className="assistant-task-manual" aria-label={m.body}>
    <div className="assistant-task-tabs" role="group" aria-label={m.body}>
      {(['body', 'appendix', 'history'] as const).map(value => <button key={value} type="button" className="button quiet" aria-pressed={tab === value} onClick={() => setTab(value)}>{m[value]}{value === 'appendix' ? ` (${active.length})` : value === 'history' ? ` · v${task.manualVersion}` : ''}</button>)}
    </div>
    <div hidden={tab !== 'body'}><section className="assistant-task-panel"><header><h3>{m.body}</h3><span className="assistant-task-badge">v{manual.version}</span></header><AssistantTaskMarkdown text={manual.body} /></section><section className="assistant-task-panel"><h3>{m.rules}</h3><pre className="assistant-task-rules">{stringifyAssistantTaskJson(manual.rules, 2)}</pre></section></div>
    <div hidden={tab !== 'appendix'}><p className="assistant-task-meta">{m.appendixBoundary}</p>
      {active.length === 0 ? <p className="assistant-task-empty">{m.noAppendix}</p> : <ul className="assistant-task-appendix">{active.map(entry => <AppendixEntry key={entry.id} entry={entry} taskVersion={task.version} disabled={disabled} onEdit={onAppendixEdit} onDelete={onAppendixDelete} {...(onRecords ? { onRecords } : {})} />)}</ul>}
    </div>
    <div hidden={tab !== 'history'}>
      {histories.length === 0 ? <p className="assistant-task-empty">{m.noHistory}</p> : <ol className="assistant-task-history">{histories.toSorted((left, right) => BigInt(left.version) > BigInt(right.version) ? -1 : 1).map(version => <HistoryEntry key={version.version} manual={version} taskVersion={task.version} current={task.manualVersion === version.version} disabled={disabled} onRollback={onRollback} />)}</ol>}
      {historyHasMore ? <button className="button" type="button" disabled={disabled} onClick={onMoreHistory}>{m.moreHistory}</button> : null}
      {proposals.filter(proposal => proposal.status !== 'pending').map(proposal => <article key={proposal.id} className="assistant-task-entry" id={`proposal-${proposal.id}`}>
        <header><span className="assistant-task-badge">{m[proposal.status]}</span><span>{m.base.replace('{version}', proposal.baseVersion)}</span><time dateTime={proposal.decidedAt ?? proposal.createdAt}>{new Date(proposal.decidedAt ?? proposal.createdAt).toLocaleString(m.locale)}</time></header>
        <AssistantTaskMarkdown text={proposal.reason} />{proposal.decisionNote ? <><h4>{m.decisionNote}</h4><AssistantTaskMarkdown text={proposal.decisionNote} /></> : null}
        <AssistantTaskEvidence ids={proposal.evidenceRecords} {...(onRecords ? { onRecords } : {})} />
        <details><summary>{m.proposedBody}</summary><AssistantTaskMarkdown text={proposal.body} /><pre className="assistant-task-rules">{stringifyAssistantTaskJson(proposal.rules, 2)}</pre></details>
      </article>)}
    </div>
  </section>;
}
function AppendixEntry({ entry, taskVersion, disabled, onEdit, onDelete, onRecords }: {
  readonly entry: AssistantTaskAppendix; readonly taskVersion: string; readonly disabled: boolean;
  readonly onEdit: AssistantTaskManualProps['onAppendixEdit']; readonly onDelete: AssistantTaskManualProps['onAppendixDelete']; readonly onRecords?: (id: string) => void;
}) {
  const m = useAssistantTaskContentMessages(), id = useId();
  const [observedVersion, setObservedVersion] = useState(taskVersion);
  const [editing, setEditing] = useState(false), [deleting, setDeleting] = useState(false), [text, setText] = useState(entry.text), [busy, setBusy] = useState(false);
  const submit = async (remove: boolean) => {
    if (busy || disabled || !remove && observedVersion !== taskVersion) return;
    setBusy(true);
    try { if (await (remove ? onDelete(entry, observedVersion) : onEdit(entry, text, observedVersion))) { setEditing(false); setDeleting(false); } }
    finally { setBusy(false); }
  };
  return <li className="assistant-task-entry">
    {editing ? <form className="assistant-task-form" onSubmit={event => { event.preventDefault(); void submit(false); }}>
      {observedVersion !== taskVersion ? <p role="status">{m.staleDraft}</p> : null}<label htmlFor={id}>{m.text}</label><textarea id={id} rows={5} value={text} required onChange={event => setText(event.target.value)} />
      <div className="assistant-task-actions"><button className="button primary" type="submit" disabled={disabled || busy || !text.trim() || observedVersion !== taskVersion}>{m.save}</button><button className="button" type="button" disabled={busy} onClick={() => setEditing(false)}>{m.cancel}</button></div>
    </form> : <><AssistantTaskMarkdown text={entry.text} /><time className="assistant-task-meta" dateTime={entry.updatedAt}>{new Date(entry.updatedAt).toLocaleString(m.locale)}</time><AssistantTaskEvidence ids={entry.sourceRecords} {...(onRecords ? { onRecords } : {})} />
      {deleting ? <div role="group" aria-label={m.confirmRemove}><p>{m.confirmRemove}</p><div className="assistant-task-actions"><button className="button danger" type="button" disabled={disabled || busy} onClick={() => void submit(true)}>{m.remove}</button><button className="button" type="button" disabled={busy} onClick={() => setDeleting(false)}>{m.cancel}</button></div></div> : <div className="assistant-task-actions"><button className="button" type="button" disabled={disabled || busy} onClick={() => { setText(entry.text); setObservedVersion(taskVersion); setEditing(true); }}>{m.edit}</button><button className="button danger" type="button" disabled={disabled || busy} onClick={() => { setObservedVersion(taskVersion); setDeleting(true); }}>{m.remove}</button></div>}
    </>}
  </li>;
}
function HistoryEntry({ manual, taskVersion, current, disabled, onRollback }: { readonly manual: Manual; readonly taskVersion: string; readonly current: boolean; readonly disabled: boolean; readonly onRollback: AssistantTaskManualProps['onRollback'] }) {
  const m = useAssistantTaskContentMessages();
  const [observedVersion, setObservedVersion] = useState(taskVersion);
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false);
  return <li className="assistant-task-entry">
    <header><strong>v{manual.version}</strong>{current ? <span className="assistant-task-badge">{m.current}</span> : null}<span>{manual.source === 'rollback' ? m.rollbackSource : m[manual.source]}</span><time dateTime={manual.createdAt}>{new Date(manual.createdAt).toLocaleString(m.locale)}</time></header>
    <details><summary>{m.body}</summary><AssistantTaskMarkdown text={manual.body} /><h4>{m.rules}</h4><pre className="assistant-task-rules">{stringifyAssistantTaskJson(manual.rules, 2)}</pre></details>
    {!current ? confirming ? <div role="group" aria-label={m.confirmRollback}><p>{m.rollbackConfirm.replace('{version}', manual.version)}</p><div className="assistant-task-actions"><button className="button primary" type="button" disabled={disabled || busy} onClick={async () => { if (busy || disabled) return; setBusy(true); try { if (await onRollback(manual.version, observedVersion)) setConfirming(false); } finally { setBusy(false); } }}>{m.confirmRollback}</button><button className="button" type="button" disabled={busy} onClick={() => setConfirming(false)}>{m.cancel}</button></div></div> : <button className="button" type="button" disabled={disabled} onClick={() => { setObservedVersion(taskVersion); setConfirming(true); }}>{m.rollback.replace('{version}', manual.version)}</button> : null}
  </li>;
}
