import { useId, useState } from 'react';
import type { AssistantTaskDecisionInput, AssistantTaskJson, AssistantTaskProposal } from '../../api/assistant-tasks';
import { parseAssistantTaskJson, stringifyAssistantTaskJson } from '../../api/assistant-tasks';
import { ChatMarkdown } from '../../ui/ChatMarkdown';
import { useAssistantTaskContentMessages } from './assistant-task-messages';
import '../../styles/markdown.css';

export type AssistantTaskDecision = Omit<AssistantTaskDecisionInput, 'ifVersion'>;
export type AssistantTaskProposalPanelProps = {
  readonly proposals: readonly AssistantTaskProposal[];
  readonly disabled: boolean;
  readonly taskVersion: string;
  readonly onDecide: (proposal: AssistantTaskProposal, decision: AssistantTaskDecision, ifVersion: string) => Promise<boolean>;
  readonly onRecords?: (id: string) => void;
};
export function AssistantTaskProposalPanel({ proposals, taskVersion, disabled, onDecide, onRecords }: AssistantTaskProposalPanelProps) {
  const m = useAssistantTaskContentMessages();
  const pending = proposals.filter(proposal => proposal.status === 'pending');
  return <section className="assistant-task-proposals" id="assistant-task-proposals" aria-label={m.proposals}>
    <h3>{m.proposals}</h3>
    {pending.length === 0 ? <p className="assistant-task-empty">{m.noProposals}</p> : pending.map(proposal => <Proposal key={proposal.id} proposal={proposal} taskVersion={taskVersion} disabled={disabled} onDecide={onDecide} {...(onRecords ? { onRecords } : {})} />)}
  </section>;
}
function Proposal({ proposal, taskVersion, disabled, onDecide, onRecords }: Omit<AssistantTaskProposalPanelProps, 'proposals'> & { readonly proposal: AssistantTaskProposal }) {
  const m = useAssistantTaskContentMessages(), formId = useId();
  const [observedVersion, setObservedVersion] = useState(taskVersion);
  const [mode, setMode] = useState<'view' | 'edited' | 'rejected'>('view');
  const [body, setBody] = useState(proposal.body), [rules, setRules] = useState(stringifyAssistantTaskJson(proposal.rules, 2));
  const [note, setNote] = useState(''), [invalid, setInvalid] = useState(false), [busy, setBusy] = useState(false);
  const decide = async (decision: AssistantTaskDecision) => {
    if (busy || disabled || mode !== 'view' && observedVersion !== taskVersion) return;
    setBusy(true);
    try { if (await onDecide(proposal, decision, mode === 'view' ? taskVersion : observedVersion)) { setMode('view'); setNote(''); } }
    finally { setBusy(false); }
  };
  return <article id={`proposal-${proposal.id}`} className={`assistant-task-proposal${proposal.widens ? ' assistant-task-widens' : ''}`}>
    <header><span className="assistant-task-badge">{m.pending}</span><span>{m.base.replace('{version}', proposal.baseVersion)}</span><time dateTime={proposal.createdAt}>{new Date(proposal.createdAt).toLocaleString(m.locale)}</time></header>
    {proposal.widens ? <div className="assistant-task-widening"><strong>{m.widens}</strong><p>{m.widensExplanation}</p></div> : null}
    <h4>{m.reason}</h4><AssistantTaskMarkdown text={proposal.reason} />
    <AssistantTaskEvidence ids={proposal.evidenceRecords} {...(onRecords ? { onRecords } : {})} />
    <details><summary>{m.proposedBody}</summary><AssistantTaskMarkdown text={proposal.body} /></details>
    <details><summary>{m.proposedRules}</summary><pre className="assistant-task-rules">{stringifyAssistantTaskJson(proposal.rules, 2)}</pre></details>
    {mode === 'view' ? <div className="assistant-task-actions">
      <button className="button primary" type="button" disabled={disabled || busy} onClick={() => void decide({ decision: 'approved' })}>{m.approve}</button>
      <button className="button" type="button" disabled={disabled || busy} onClick={() => { setObservedVersion(taskVersion); setBody(proposal.body); setRules(stringifyAssistantTaskJson(proposal.rules, 2)); setNote(''); setInvalid(false); setMode('edited'); }}>{m.editApprove}</button>
      <button className="button danger" type="button" disabled={disabled || busy} onClick={() => { setObservedVersion(taskVersion); setNote(''); setMode('rejected'); }}>{m.reject}</button>
    </div> : <form className="assistant-task-form" onSubmit={event => {
      event.preventDefault();
      if (mode === 'rejected') { void decide({ decision: 'rejected', note }); return; }
      let parsed: AssistantTaskJson;
      try { parsed = parseAssistantTaskJson(rules); } catch { setInvalid(true); return; }
      setInvalid(false); void decide({ decision: 'edited', body, ...(proposal.rules === null && parsed === null ? {} : { rules: parsed }), note });
    }}>
      {observedVersion !== taskVersion ? <p role="status">{m.staleDraft}</p> : null}
      {mode === 'edited' ? <>
        <label htmlFor={`${formId}-body`}>{m.proposedBody}</label><textarea id={`${formId}-body`} value={body} rows={10} required onChange={event => setBody(event.target.value)} />
        <label htmlFor={`${formId}-rules`}>{m.proposedRules}</label><textarea id={`${formId}-rules`} value={rules} rows={8} required aria-invalid={invalid} aria-describedby={invalid ? `${formId}-error` : undefined} onChange={event => { setRules(event.target.value); setInvalid(false); }} />
        {invalid ? <p id={`${formId}-error`} role="alert">{m.invalidRules}</p> : null}
      </> : null}
      <label htmlFor={`${formId}-note`}>{mode === 'rejected' ? m.rejectReason : m.decisionNote}</label><textarea id={`${formId}-note`} value={note} rows={3} required={mode === 'rejected'} onChange={event => setNote(event.target.value)} />
      <div className="assistant-task-actions"><button className="button primary" disabled={disabled || busy || observedVersion !== taskVersion || (mode === 'rejected' ? !note.trim() : !body.trim())} type="submit">{mode === 'rejected' ? m.reject : m.editApprove}</button><button className="button" type="button" disabled={busy} onClick={() => setMode('view')}>{m.cancel}</button></div>
    </form>}
  </article>;
}
export function AssistantTaskMarkdown({ text }: { readonly text: string }) {
  const m = useAssistantTaskContentMessages();
  return <ChatMarkdown text={text} resourceUnavailable={m.resourcesUnavailable} tableLabel={m.table} />;
}
export function AssistantTaskEvidence({ ids, onRecords }: { readonly ids: readonly string[]; readonly onRecords?: (id: string) => void }) {
  const m = useAssistantTaskContentMessages();
  if (ids.length === 0) return null;
  return <div className="assistant-task-evidence"><span>{m.evidence}</span>{ids.map(id => onRecords
    ? <button className="button quiet" type="button" key={id} onClick={() => onRecords(id)}>{m.record.replace('{id}', id)}</button>
    : <code key={id}>{id}</code>)}</div>;
}
