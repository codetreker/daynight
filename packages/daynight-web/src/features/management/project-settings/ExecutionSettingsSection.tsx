import type { useProjectSettings } from '../useProjectSettings';
import type { ProjectManagementGuard } from '../ProjectManagementGuard';
import { useI18n } from '../../../i18n/LocaleProvider';
import { ManagementError } from '../feedback';

export const ExecutionSettingsSection = ({ state, guard }: { readonly state: ReturnType<typeof useProjectSettings>; readonly guard: ProjectManagementGuard }) => {
  const { messages: { auth: { management: { settings: m, common } } } } = useI18n();
  const disabled = state.pending || state.loading || state.uncertain || state.role !== 'admin';
  return <>
    {state.reconciliation !== null ? <div className="notice warning" role="alert"><p>{state.reconciliation === "conflict" ? m.conflictPending : m.permissionPending}</p>{state.error === null && <button className="button" type="button" disabled={state.pending || state.loading} onClick={state.retry}>{common.retry}</button>}</div> : state.writeError !== null && <ManagementError error={state.writeError} retry={state.retry} />}
    {state.uncertain && <div className="notice warning" role="alert"><p>{m.uncertain}</p>{!state.loading && <button className="button" type="button" onClick={state.retry}>{m.retryRead}</button>}</div>}
    {state.loading && <div className="empty-inline" role="status">{m.loading}</div>}
    {state.unavailable && state.error === null && <div className="notice error" role="alert">{common.notFound}{state.pending && <button className="button" type="button" onClick={state.retry}>{common.retry}</button>}</div>}
    {state.project !== null && !state.unavailable && <>
      {state.role === "member" && <div className="notice">{m.memberNotice}</div>}
      <section className="panel project-settings-panel" aria-labelledby="threshold-title"><div className="panel-heading"><div><h2 id="threshold-title">{m.alertTitle}</h2><p>{m.description}</p></div><span className="badge admin">{m.scope}</span></div>
        <form className="panel-body" noValidate onSubmit={(event) => { event.preventDefault(); void state.save(); }}>
          {state.draftConflict && <p className="notice warning" role="alert">{m.draftConflict} <strong>{m.currentSaved}: {state.project.settings.executionWarningMinutes} {m.unit}</strong></p>}
          <div className="field"><label htmlFor="execution-warning-minutes">{m.label}</label><div className="number-unit"><input id="execution-warning-minutes" name="executionWarningMinutes" type="number" min="1" max="2147483647" step="1" required value={state.draft} disabled={state.loading || state.uncertain || state.role !== "admin"} aria-invalid={state.invalid || undefined} aria-describedby={`threshold-hint${state.invalid ? " threshold-error" : ""}`} onChange={(event) => state.change(event.target.value)} /><span>{m.unit}</span></div><p className="hint" id="threshold-hint">{m.hint}</p>{state.invalid && <p className="hint error" id="threshold-error" role="alert">{m.invalid}</p>}</div>
          {state.role !== "member" && <div className="settings-actions"><button className="button primary" type="submit" disabled={disabled || guard.isBlocked("settings") || !state.canSubmit || !state.dirty}>{state.pending ? m.busy : m.save}</button><button className="button" type="button" disabled={disabled || !state.dirty && !state.draftConflict} onClick={state.cancel}>{common.cancel}</button></div>}
          <p className={`settings-state${state.notice === "saved" && !state.hasUnsavedDraft ? " success" : ""}`} role="status">{state.notice === "saved" && state.hasUnsavedDraft ? m.unsaved : state.notice !== null ? m.notice[state.notice] : state.dirty ? m.unsaved : ""}</p>
        </form>
      </section>
    </>}
  </>;
};
