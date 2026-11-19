import { useId } from 'react';
import { ApiError } from '../../../api/client';
import { useI18n } from '../../../i18n/LocaleProvider';
import { OperationPublicationError } from '../../teams/TeamManagement';
import { ManagementDialog } from '../ManagementDialog';
import { repositoryMessages } from './messages';
import { useProjectRepository, type RepositoryEditorProps } from './useProjectRepository';
import './repository.css';

export const ProjectRepository = (props: RepositoryEditorProps) => {
  const { locale } = useI18n(), m = repositoryMessages[locale], state = useProjectRepository(props);
  const field = useId(), hint = useId(), problem = useId(), title = useId(), impact = useId();
  const { preview, op } = state;
  const error = state.error ?? op.result?.error;
  const detail = error instanceof ApiError && error.code === 'project_repository_conflict' ? m.occupied : state.conflict ? m.conflict : state.unknown ? m.unknown : op.result !== null ? m.rejected : state.dialog && state.unknown ? m.readFailed : m.failed;
  const errorNotice = error !== undefined && error !== null && <div className="notice error" role="alert"><p>{detail}</p>{error instanceof ApiError && error.requestId !== null && <p>{m.request}<code>{error.requestId}</code></p>}</div>;
  const switching = preview?.bindingsInvalidated === true;
  return <section className="panel project-settings-panel repository-card" aria-labelledby={title}>
    <div className="panel-heading"><div><h2 id={title}>{m.title}</h2></div></div>
    <div className="panel-body">
      {state.privateAvailable && <>
        <dl className="team-settings-details"><div><dt>{m.current}</dt><dd className="repository-current"><code>{props.repoUrl}</code></dd></div></dl>
        <form onSubmit={event => { event.preventDefault(); void state.inspect(); }} noValidate>
          <div className="field"><label htmlFor={field}>{m.target}</label><input id={field} type="text" autoComplete="off" autoCapitalize="off" spellCheck={false} aria-describedby={`${hint} ${problem}`} aria-invalid={state.invalid !== null} value={state.draft} disabled={!state.editable || state.busy || state.unknown} onChange={event => state.change(event.target.value)} /><p className="hint" id={hint}>{m.hint}</p><div id={problem}>{state.invalid !== null && <p className="hint error" role="alert">{m[state.invalid]}</p>}</div></div>
          <div className="settings-actions"><button className="button primary" type="submit" disabled={!props.active || !state.editable || state.busy || state.reading || state.unknown || props.guard.isBlocked('repository')}>{m.preview}</button></div>
          {!state.editable && <p className="settings-state">{m.restricted}</p>}
        </form>
      </>}
      <div aria-live="polite">
        {!state.dialog && errorNotice}
        {!state.dialog && <OperationPublicationError operation={op} zh={locale === 'zh-CN'} />}
        {state.saved !== null && <div className="notice success" role="status">{state.saved.bindingsInvalidated ? m.switched : m.saved}</div>}
        {state.unknown && !state.dialog && <div className="notice warning" role="alert"><p>{m.unknown}</p><button className="button" type="button" onClick={state.reopen}>{m.check}</button></div>}
      </div>
    </div>
    {state.dialog && <ManagementDialog className="project-settings-dialog" title={m.confirm} initialFocus="cancel" busy={state.busy} suspended={!props.active || !state.privateAvailable && !state.unknown} onClose={state.close} footer={<>
      <button className="button" type="button" data-dialog-cancel disabled={state.busy} onClick={state.close}>{state.unknown ? m.close : m.cancel}</button>
      {state.unknown ? <button className="button primary" type="button" disabled={state.reading} onClick={() => { void state.check(); }}>{state.reading ? m.reading : m.check}</button>
        : preview === null ? <button className="button primary" type="button" disabled={state.reading || !state.editable} onClick={() => { void state.inspect(); }}>{m.retryPreview}</button>
        : <button className={`button ${switching ? 'danger' : 'primary'}`} type="button" aria-describedby={switching ? impact : undefined} disabled={state.busy || state.reading || !state.editable || props.guard.isBlocked('repository') || preview.classification === 'unchanged' || preview.classification === 'unverified' && !state.acknowledged} onClick={state.submit}>{state.busy ? m.saving : switching ? m.switch : m.save}</button>}
    </>}>
      <OperationPublicationError operation={op} zh={locale === 'zh-CN'} />
      {state.reading && !state.unknown && <p role="status">{m.checking}</p>}
      {preview !== null && state.privateAvailable && !state.unknown && <>
        <dl className="project-deletion-details"><dt>{m.project}</dt><dd>{preview.projectName}</dd><dt>{m.current}</dt><dd><code>{preview.currentRepoUrl}</code></dd><dt>{m.target}</dt><dd><code>{preview.repoUrl}</code></dd></dl>
        <p role="status">{m[preview.classification === 'same_repository' ? 'same' : preview.classification === 'different_repository' ? 'different' : preview.classification]}</p>
        {switching && <div className="notice warning" id={impact}><p><strong>{m.impact}</strong></p><ul className="repository-impact"><li>{m.github}</li><li>{m.worker}</li></ul></div>}
        {preview.classification === 'unverified' && <label className="repository-ack"><input type="checkbox" checked={state.acknowledged} disabled={state.busy} onChange={event => state.setAcknowledged(event.target.checked)} /><span>{m.acknowledge}</span></label>}
      </>}
      {state.conflict && <p className="notice warning" role="alert">{m.conflict}</p>}
      {errorNotice}
      {state.unknown && <div className="notice warning" role="alert"><p>{m.unknown}</p>{state.observed !== null && state.privateAvailable && <p>{m.observed}: <code>{state.observed}</code></p>}{state.error !== null && <p>{m.readFailed}</p>}</div>}
    </ManagementDialog>}
  </section>;
};
