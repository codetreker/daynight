import { useId, useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import { NativeSelect } from '../../ui/native-select/NativeSelect';
import { promptMessages } from './messages';
import type { WorkerPromptController } from './useWorkerPrompt';
import './worker-prompts.css';

export const WorkerPromptEditor = ({ state, scope }: { readonly state: WorkerPromptController; readonly scope: 'user' | 'project' | 'worker' }) => {
  const { locale } = useI18n(), m = promptMessages(locale), id = useId();
  const [scenario, setScenario] = useState<'start' | 'resume' | 'ping'>('start');
  if (state.unavailable) return <section className="state-box" role="status">{m.unavailable}</section>;
  if (state.resource === null) return <section className="state-box" role={state.read === 'error' ? 'alert' : 'status'}>{state.read === 'error' ? <><p>{m.readError}</p><button className="button" type="button" disabled={!state.readEnabled} onClick={state.refresh}>{m.retry}</button></> : m.loading}</section>;
  const examples = { start: 'You are executing a worker-managed task.\nRead the assigned task and complete its acceptance criteria.', resume: 'Resume the original worker-managed task.\nRead its current state and continue the unfinished work.', ping: '<system remider>\nContinue the current worker-managed task.\nCheck the latest task state and keep progressing until completion.\n</system remider>' };
  const preview = (['user', 'project', 'worker'] as const).reduce<string>((text, layer) => {
    const value = layer === scope ? state.draft : m.placeholder;
    return value === '' ? text : `${text}\n\n----- begin ${layer} prompt -----\n${value}\n----- end ${layer} prompt -----`;
  }, examples[scenario]);
  const submit = (event: FormEvent) => { event.preventDefault(); void state.save(); };
  return <div className="worker-prompt">
    <div className="worker-prompt-layout"><section className="panel worker-prompt-panel"><header className="panel-heading"><div><h2>{m.titles[scope]}</h2><p>{m.descriptions[scope]}</p></div></header>
      <form className="panel-body" onSubmit={submit} noValidate>
        {state.conflict && <div className="notice warning" role="alert"><p>{m.conflict}</p>{state.conflictReady ? <><details><summary>{m.latest}</summary><pre className="worker-prompt-latest">{state.resource.text}</pre></details><div className="worker-prompt-actions"><button className="button" type="button" onClick={state.useLatest}>{m.useLatest}</button><button className="button" type="button" onClick={state.keepDraft}>{m.keepDraft}</button></div></> : <button className="button" type="button" disabled={!state.readEnabled || state.read === 'pending'} onClick={state.refresh}>{m.retry}</button>}</div>}
        {state.uncertain && <div className="notice warning" role="alert"><p>{m.uncertain}</p><button className="button" type="button" disabled={!state.readEnabled || state.read === 'pending'} onClick={state.refresh}>{m.verify}</button></div>}
        {state.readError !== null && <div className="notice error" role="alert">{m.readError} <button className="button" type="button" disabled={!state.readEnabled} onClick={state.refresh}>{m.retry}</button></div>}
        {state.writeError !== null && !state.uncertain && !state.conflict && <p className="notice error" role="alert">{m.saveError}</p>}
        {state.confirmed && <p className="notice" role="status">{m.confirmed}</p>}
        {state.reconciled && <p className="notice" role="status">{m.reconciled}</p>}
        <div className="field"><label htmlFor={id}>{m.text}</label><textarea id={id} className="worker-prompt-text" rows={9} spellCheck={false} value={state.draft} aria-describedby={`${id}-hint`} aria-invalid={state.invalid || state.tooLarge || undefined} onChange={event => state.edit(event.target.value)} /><p className="hint" id={`${id}-hint`}>{m.hint}</p>
          {state.invalid && <p className="hint error" role="alert">{m.invalid}</p>}{state.tooLarge && <p className="hint error" role="alert">{m.tooLarge}</p>}
          <p className="hint">{m.revision}: {state.resource.revision}</p></div>
        <div className="worker-prompt-actions"><span role="status">{state.dirty ? m.dirty : m.clean}</span><button className="button" type="button" disabled={!state.dirty || state.pending || state.confirmed || state.uncertain} onClick={state.discard}>{m.discard}</button><button className="button primary" type="submit" disabled={!state.readEnabled || !state.dirty || state.pending || state.confirmed || state.uncertain || state.conflict || state.invalid || state.tooLarge}>{state.pending ? m.saving : m.save}</button></div>
      </form></section>
      <aside className="worker-prompt-aside"><section className="panel"><header className="panel-heading"><h2>{m.order}</h2></header><div className="panel-body"><ol><li>{m.builtin}</li>{(['user', 'project', 'worker'] as const).map(layer => <li key={layer}><strong>{m.titles[layer]}</strong></li>)}</ol></div></section><section className="panel"><header className="panel-heading"><h2>{m.timing}</h2></header><div className="panel-body">{m.timingDetail}</div></section></aside></div>
    <section className="panel worker-prompt-preview"><header className="panel-heading"><div><h2>{m.preview}</h2><p>{m.example}</p></div></header><div className="panel-body"><label htmlFor={`${id}-scenario`}>{m.scenario}</label>{' '}<NativeSelect density="filter" layout="content" id={`${id}-scenario`} value={scenario} onChange={event => setScenario(event.target.value as typeof scenario)}><option value="start">{m.start}</option><option value="resume">{m.resume}</option><option value="ping">{m.ping}</option></NativeSelect><pre tabIndex={0}>{preview}</pre>{scenario === 'resume' && <p className="hint">{m.resumeNote}</p>}</div></section>
  </div>;
};
