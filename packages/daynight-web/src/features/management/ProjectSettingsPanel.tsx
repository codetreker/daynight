import type { BrowserLocation } from "../../app/navigation";
import type { TransferNavigationContext } from "./transfer-navigation";
import { useLayoutEffect } from "react";
import { ProjectAccessBoundary } from "../projects/ProjectAccess";
import type { CurrentUser } from "../../api/auth";
import { useI18n } from "../../i18n/LocaleProvider";
import { ManagementError } from "./feedback";
import { useProjectSettings } from "./useProjectSettings";
import { ProjectOwnership } from "./ProjectOwnership";
import type { ProjectTransferReceipt } from "../../api/project-transfer";
import { usePromptNavigation } from "./AccountPage";
import { useWorkerPrompt } from "../worker-prompts/useWorkerPrompt";
import { WorkerPromptEditor } from "../worker-prompts/WorkerPromptEditor";
import type { ProjectDeletionReceipt } from "../../api/project-deletion";
import { ProjectDeletion } from "./ProjectDeletion";
import { useProjectManagementGuard } from "./ProjectManagementGuard";
import { GitHubSettings } from "../github-integration/GitHubSettings";
import type { ReactNode } from "react";

type Props = { readonly projectId: string; readonly user: CurrentUser; readonly navigation?: ReactNode; readonly unavailableView?: ReactNode; readonly onTransferred?: ((receipt: ProjectTransferReceipt, context: TransferNavigationContext) => void) | undefined; readonly onDeleted?: ((receipt: ProjectDeletionReceipt, finish: (signal?: AbortSignal) => Promise<void | "skipped">, location: BrowserLocation, canFinalize: () => boolean) => void) | undefined; readonly onDeletionOutcome?: ((kind: "unknown" | "rejected", error: unknown, check: () => Promise<"available" | "unavailable">) => void) | undefined; readonly active?: boolean; readonly onRoute?: boolean; readonly onRetentionChange?: ((retain: boolean) => void) | undefined; readonly onSettingsRetentionChange?: ((retain: boolean) => void) | undefined; readonly onGitHubRetentionChange?: ((retain: boolean) => void) | undefined; readonly onDeletionRetentionChange?: ((retain: boolean) => void) | undefined; readonly onPromptRetentionChange?: ((retain: boolean) => void) | undefined };

export const ProjectSettingsPanel = ({ projectId, user, navigation, unavailableView, onTransferred, onDeleted, onDeletionOutcome, active = true, onRoute = true, onRetentionChange, onSettingsRetentionChange, onGitHubRetentionChange, onDeletionRetentionChange, onPromptRetentionChange }: Props) =>
  <ProjectAccessBoundary projectId={projectId} initialRead active={active}><ProjectSettingsContent key={`${user.id}:${projectId}`} projectId={projectId} user={user} navigation={navigation} unavailableView={unavailableView} onTransferred={onTransferred} onDeleted={onDeleted} onDeletionOutcome={onDeletionOutcome} active={active} onRoute={onRoute} onRetentionChange={onRetentionChange} onSettingsRetentionChange={onSettingsRetentionChange} onGitHubRetentionChange={onGitHubRetentionChange} onDeletionRetentionChange={onDeletionRetentionChange} onPromptRetentionChange={onPromptRetentionChange} /></ProjectAccessBoundary>;

const ProjectSettingsContent = ({ projectId, user, navigation, unavailableView, onTransferred, onDeleted, onDeletionOutcome, active, onRoute, onRetentionChange, onSettingsRetentionChange, onGitHubRetentionChange, onDeletionRetentionChange, onPromptRetentionChange }: Props & { readonly active: boolean; readonly onRoute: boolean }) => {
  const { messages: { auth: { management: { settings: m, common } } } } = useI18n();
  const guard = useProjectManagementGuard();
  const state = useProjectSettings(projectId, user.id, onRoute, active, onSettingsRetentionChange, guard);
  const prompt = useWorkerPrompt({ scope: 'project', projectId }, { readEnabled: active });
  const promptNavigation = usePromptNavigation({ scope: 'project', projectId }, prompt);
  useLayoutEffect(() => { onPromptRetentionChange?.(prompt.pending || prompt.confirmed || prompt.uncertain); }, [onPromptRetentionChange, prompt.pending, prompt.confirmed, prompt.uncertain]);
  const disabled = state.pending || state.loading || state.uncertain || state.role !== "admin";
  const showUnavailable = state.unavailable && unavailableView !== undefined && !guard.isBlocked("delete");
  return <div ref={promptNavigation.owner} onFocusCapture={promptNavigation.rememberFocus}>
    {showUnavailable ? unavailableView : navigation}
    <div hidden={showUnavailable} inert={showUnavailable}>
    <div className="page-heading"><div><div className="eyebrow">{m.eyebrow}</div><h1 tabIndex={-1}>{state.project?.name ?? m.title}</h1><p className="subtitle">{m.scopeHint}</p></div></div>
    {state.error !== null && <ManagementError error={state.error} retry={state.retry} />}
    {state.reconciliation !== null ? <div className="notice warning" role="alert"><p>{state.reconciliation === "conflict" ? m.conflictPending : m.permissionPending}</p>{state.error === null && <button className="button" type="button" disabled={state.pending || state.loading} onClick={state.retry}>{common.retry}</button>}</div> : state.writeError !== null && <ManagementError error={state.writeError} retry={state.retry} />}
    {state.uncertain && <div className="notice warning" role="alert"><p>{m.uncertain}</p>{!state.loading && <button className="button" type="button" onClick={state.retry}>{m.retryRead}</button>}</div>}
    {state.loading && <div className="empty-inline" role="status">{m.loading}</div>}
    {state.unavailable && state.error === null && <div className="notice error" role="alert">{common.notFound}{state.pending && <button className="button" type="button" onClick={state.retry}>{common.retry}</button>}</div>}
    {state.project !== null && !state.unavailable && <>
      {state.role === "member" && <div className="notice">{m.memberNotice}</div>}
      <section className="panel project-settings-panel" aria-labelledby="threshold-title"><div className="panel-heading"><div><h2 id="threshold-title">{m.alertTitle}</h2><p>{m.description}</p></div><span className="badge admin">{m.scope}</span></div>
        <form className="panel-body" noValidate onSubmit={(event) => { event.preventDefault(); void state.save(); }}>
          {state.draftConflict && <p className="notice warning" role="alert">{m.draftConflict} <strong>{m.currentSaved}: {state.project.settings.executionWarningMinutes} {m.unit}</strong></p>}
          <div className="field"><label htmlFor="execution-warning-minutes">{m.label}</label><div className="number-unit"><input id="execution-warning-minutes" name="executionWarningMinutes" type="number" min="1" max="2147483647" step="1" required value={state.draft} disabled={disabled} aria-invalid={state.invalid || undefined} aria-describedby={`threshold-hint${state.invalid ? " threshold-error" : ""}`} onChange={(event) => state.change(event.target.value)} /><span>{m.unit}</span></div><p className="hint" id="threshold-hint">{m.hint}</p>{state.invalid && <p className="hint error" id="threshold-error" role="alert">{m.invalid}</p>}</div>
          {state.role !== "member" && <div className="settings-actions"><button className="button primary" type="submit" disabled={disabled || guard.isBlocked("settings") || !state.canSubmit || !state.dirty}>{state.pending ? m.busy : m.save}</button><button className="button" type="button" disabled={disabled || !state.dirty && !state.draftConflict} onClick={state.cancel}>{common.cancel}</button></div>}
          <p className={`settings-state${state.notice === "saved" ? " success" : ""}`} role="status">{state.notice !== null ? m.notice[state.notice] : state.dirty ? m.unsaved : ""}</p>
        </form>
      </section>
    </>}
    <GitHubSettings projectId={projectId} userId={user.id} repoUrl={state.project?.repoUrl ?? null} active={active} onRoute={onRoute} guard={guard} onRetentionChange={onGitHubRetentionChange} />
    <WorkerPromptEditor state={prompt} scope="project" />
    <ProjectOwnership projectId={projectId} projectName={state.project?.name ?? null} onTransferred={onTransferred} active={active} onRoute={onRoute} unavailable={state.unavailable} onRetentionChange={onRetentionChange} guard={guard} />
    <ProjectDeletion projectId={projectId} active={active} onRoute={onRoute} unavailable={state.unavailable} onRetentionChange={onDeletionRetentionChange} guard={guard} onDeleted={onDeleted} onOutcome={onDeletionOutcome} />
    </div>
    {promptNavigation.confirmation}
  </div>;
};
