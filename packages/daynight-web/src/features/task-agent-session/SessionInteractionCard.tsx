import { useState, type FormEvent } from 'react';
import type { InteractionResponse, SessionInteraction } from '../../api/types';
import { useSessionMessages } from './messages';

// Native interaction cards follow the typed controls in ARC's FormCard and QuestionCard:
// https://github.com/xuangong/agent-remote-control/tree/f166d2f570bbcf8f6c68bd009c701e85b8457943/packages/agent-remote-web/src/react/interactions
export function SessionInteractionCard({ interaction, enabled, onRespond }: {
  readonly interaction: SessionInteraction; readonly enabled: boolean; readonly onRespond: (response: InteractionResponse) => Promise<void>;
}) {
  const m = useSessionMessages();
  const [values, setValues] = useState<Record<string, string | readonly string[]>>({});
  const [resolved, setResolved] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = !enabled || resolved || pending || interaction.state !== 'pending';
  const change = (key: string, value: string | readonly string[]) => { setValues((current) => ({ ...current, [key]: value })); setError(null); };
  async function respond(response: InteractionResponse) {
    if (disabled) return;
    setPending(true); setError(null);
    try { await onRespond(response); setResolved(true); } catch (cause) { setError(cause instanceof Error ? cause.message : m.failure); }
    finally { setPending(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || interaction.kind === 'approval') return;
    if (interaction.kind === 'question') {
      const answers = interaction.questions.map((q) => ({ questionId: q.questionId, optionIds: Array.isArray(values[q.questionId]) ? values[q.questionId] as readonly string[] : [], text: typeof values[`${q.questionId}:text`] === 'string' ? values[`${q.questionId}:text`] as string : null }));
      if (interaction.questions.some((q, index) => q.required && answers[index]!.optionIds.length === 0 && !answers[index]!.text?.trim())) { setError(m.required); return; }
      void respond({ kind: 'question', answers }); return;
    }
    const result: { fieldId: string; value: string | number | boolean | readonly string[] }[] = [];
    for (const field of interaction.fields) {
      const raw = values[field.fieldId];
      const missing = raw === undefined || raw === '' || Array.isArray(raw) && raw.length === 0;
      if (missing) { if (field.required) { setError(m.required); return; } continue; }
      let value: string | number | boolean | readonly string[] = raw!;
      if (field.type === 'number') {
        value = Number(raw);
        if (!Number.isFinite(value) || field.min !== null && value < field.min || field.max !== null && value > field.max) { setError(m.required); return; }
      } else if (field.type === 'boolean') value = raw === 'true';
      result.push({ fieldId: field.fieldId, value });
    }
    void respond({ kind: 'form', values: result });
  }
  return <section className="session-interaction" aria-label={interaction.title} aria-busy={pending}>
    <h4>{interaction.title}</h4>
    {interaction.state !== 'pending' || resolved ? <p>{resolved ? m.resolved : m[interaction.state]}</p> : <form onSubmit={submit}>
      <fieldset disabled={disabled}>
        {interaction.kind === 'approval' ? <><p className="session-prewrap">{interaction.detail}</p><div className="session-actions">{interaction.actions.map((action) => <button className="button" type="button" key={action} onClick={() => void respond({ kind: 'approval', action })}>{m[action]}</button>)}</div></> : null}
        {interaction.kind === 'question' ? interaction.questions.map((q) => <fieldset key={q.questionId}><legend>{q.label}{q.required ? ' *' : ''}</legend>
          {q.options.map((option) => { const selected = (values[q.questionId] ?? []) as readonly string[]; return <label className="session-choice" key={option.id}><input type={q.multiple ? 'checkbox' : 'radio'} name={q.questionId} checked={selected.includes(option.id)} onChange={(event) => change(q.questionId, q.multiple ? event.target.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id) : [option.id])} />{option.label}</label>; })}
          {q.allowCustom ? <label>{m.other}<input aria-label={`${q.label} — ${m.other}`} type={q.sensitive ? 'password' : 'text'} autoComplete="off" value={String(values[`${q.questionId}:text`] ?? '')} onChange={(event) => change(`${q.questionId}:text`, event.target.value)} /></label> : null}
        </fieldset>) : null}
        {interaction.kind === 'form' ? interaction.fields.map((field) => <label className="session-form-field" key={field.fieldId}><span>{field.label}{field.required ? ' *' : ''}</span>
          {field.type === 'text' || field.type === 'number' ? <input aria-label={field.label} autoComplete={field.type === 'text' && field.sensitive ? 'off' : undefined} type={field.type === 'number' ? 'number' : field.sensitive ? 'password' : 'text'} {...(field.type === 'number' ? { min: field.min ?? undefined, max: field.max ?? undefined, step: 'any' } : {})} value={String(values[field.fieldId] ?? '')} onChange={(event) => change(field.fieldId, event.target.value)} /> : null}
          {field.type === 'boolean' || field.type === 'select' ? <select aria-label={field.label} value={String(values[field.fieldId] ?? '')} onChange={(event) => change(field.fieldId, event.target.value)}><option value="">{m.choose}</option>{field.type === 'boolean' ? <><option value="true">{m.yes}</option><option value="false">{m.no}</option></> : field.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select> : null}
          {field.type === 'multiselect' ? <select multiple aria-label={field.label} value={(values[field.fieldId] ?? []) as string[]} onChange={(event) => change(field.fieldId, Array.from(event.target.selectedOptions, (o) => o.value))}>{field.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select> : null}
        </label>) : null}
        {interaction.kind !== 'approval' ? <div className="session-actions"><button className="button button-primary" type="submit">{m.submit}</button>{interaction.canDismiss ? <button className="button" type="button" onClick={() => void respond({ kind: 'dismiss' })}>{m.dismiss}</button> : null}</div> : null}
      </fieldset>
      {pending ? <p role="status">{m.pending}</p> : null}
      {error ? <p className="session-error" role="alert">{error}</p> : null}
    </form>}
  </section>;
}
