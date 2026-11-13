import type { BrowserLocation } from "../../../app/navigation";
import type { TransferNavigationContext } from "../transfer-navigation";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { browserNavigation } from "../../../app/navigation";
import { parseAuthRoute } from "../../../app/router";
import { projectSettingsUrl, type ProjectSettingsSelection, type ProjectSettingsTab } from "../../../app/project-settings-route";
import { settingsWorkspaceMessages } from "./messages";
import { ExecutionSettingsSection } from "./ExecutionSettingsSection";
import { ProjectSettingsTabs } from "./ProjectSettingsTabs";
import { useSettingsSectionScroll } from "./useSettingsSectionScroll";
import type { ProjectSettingsSectionState } from "./section-state";
import "./project-settings.css";
import { ProjectAccessBoundary } from "../../projects/ProjectAccess";
import type { CurrentUser } from "../../../api/auth";
import { useI18n } from "../../../i18n/LocaleProvider";
import { ManagementError } from "../feedback";
import { useProjectSettings } from "../useProjectSettings";
import { ProjectOwnership } from "../ProjectOwnership";
import type { ProjectTransferReceipt } from "../../../api/project-transfer";
import { usePromptNavigation } from "../AccountPage";
import { useWorkerPrompt } from "../../worker-prompts/useWorkerPrompt";
import { WorkerPromptEditor } from "../../worker-prompts/WorkerPromptEditor";
import type { ProjectDeletionReceipt } from "../../../api/project-deletion";
import { ProjectDeletion } from "../ProjectDeletion";
import { useProjectManagementGuard } from "../ProjectManagementGuard";
import { GitHubSettings } from "../../github-integration/GitHubSettings";
import { MembersPanel } from "../MembersPanel";
import type { ReactNode } from "react";

type Props = { readonly selection?: ProjectSettingsSelection; readonly projectId: string; readonly user: CurrentUser; readonly navigation?: ReactNode; readonly unavailableView?: ReactNode; readonly onTransferred?: ((receipt: ProjectTransferReceipt, context: TransferNavigationContext) => void) | undefined; readonly onDeleted?: ((receipt: ProjectDeletionReceipt, finish: (signal?: AbortSignal) => Promise<void | "skipped">, location: BrowserLocation, canFinalize: () => boolean) => void) | undefined; readonly onDeletionOutcome?: ((kind: "unknown" | "rejected", error: unknown, check: () => Promise<"available" | "unavailable">) => void) | undefined; readonly active?: boolean; readonly onRoute?: boolean; readonly onRetentionChange?: ((retain: boolean) => void) | undefined; readonly onSettingsRetentionChange?: ((retain: boolean) => void) | undefined; readonly onGitHubRetentionChange?: ((retain: boolean) => void) | undefined; readonly onDeletionRetentionChange?: ((retain: boolean) => void) | undefined; readonly onPromptRetentionChange?: ((retain: boolean) => void) | undefined; readonly onMemberRetentionChange?: ((retain: boolean) => void) | undefined; readonly onMemberRemoved?: (() => void) | undefined; readonly onMemberUnavailable?: (() => void) | undefined; readonly onMembershipChange?: (() => void) | undefined };

export const ProjectSettingsWorkspace = ({ projectId, user, selection = { kind: "tab", tab: "execution" }, navigation, unavailableView, onTransferred, onDeleted, onDeletionOutcome, active = true, onRoute = true, onRetentionChange, onSettingsRetentionChange, onGitHubRetentionChange, onDeletionRetentionChange, onPromptRetentionChange, onMemberRetentionChange, onMemberRemoved, onMemberUnavailable, onMembershipChange }: Props) =>
  <ProjectAccessBoundary projectId={projectId} initialRead active={active}><ProjectSettingsContent key={`${user.id}:${projectId}`} projectId={projectId} user={user} selection={selection} navigation={navigation} unavailableView={unavailableView} onTransferred={onTransferred} onDeleted={onDeleted} onDeletionOutcome={onDeletionOutcome} active={active} onRoute={onRoute} onRetentionChange={onRetentionChange} onSettingsRetentionChange={onSettingsRetentionChange} onGitHubRetentionChange={onGitHubRetentionChange} onDeletionRetentionChange={onDeletionRetentionChange} onPromptRetentionChange={onPromptRetentionChange} onMemberRetentionChange={onMemberRetentionChange} onMemberRemoved={onMemberRemoved} onMemberUnavailable={onMemberUnavailable} onMembershipChange={onMembershipChange} /></ProjectAccessBoundary>;

const ProjectSettingsContent = ({ projectId, user, selection = { kind: "tab", tab: "execution" }, navigation, unavailableView, onTransferred, onDeleted, onDeletionOutcome, active, onRoute, onRetentionChange, onSettingsRetentionChange, onGitHubRetentionChange, onDeletionRetentionChange, onPromptRetentionChange, onMemberRetentionChange, onMemberRemoved, onMemberUnavailable, onMembershipChange }: Props & { readonly active: boolean; readonly onRoute: boolean }) => {
  const { locale, messages: { auth: { management: { settings: m } } } } = useI18n();
  const selected = selection.kind === 'tab' ? selection.tab : null;
  const sectionActive = (tab: ProjectSettingsTab) => active && selected === tab;
  const generations = useRef({ selection: selected, onRoute, github: 0, members: 0, management: 0 });
  if (generations.current.selection !== selected || generations.current.onRoute !== onRoute) {
    if (generations.current.selection === 'github') generations.current.github++;
    if (generations.current.selection === 'members') generations.current.members++;
    if (generations.current.selection === 'management') generations.current.management++;
    generations.current.selection = selected; generations.current.onRoute = onRoute;
  }
  const capture = useSettingsSectionScroll(selected, onRoute);
  const select = useCallback((tab: ProjectSettingsTab) => {
    if (selected === tab) return;
    capture(); browserNavigation().navigate(projectSettingsUrl(projectId, tab));
  }, [capture, selected, projectId]);
  const survives = useCallback((url: URL) => { const route = parseAuthRoute(url.pathname, url.search); return route.kind === 'settings' && route.projectId === projectId; }, [projectId]);
  const guard = useProjectManagementGuard();
  const state = useProjectSettings(projectId, user.id, onRoute, active, onSettingsRetentionChange, guard);
  const prompt = useWorkerPrompt({ scope: 'project', projectId }, { readEnabled: sectionActive('prompts') });
  const promptNavigation = usePromptNavigation({ scope: 'project', projectId }, prompt, { survives, visible: sectionActive('prompts'), onContinueEditing: () => select('prompts') });
  useLayoutEffect(() => { onPromptRetentionChange?.(prompt.pending || prompt.confirmed || prompt.uncertain); }, [onPromptRetentionChange, prompt.pending, prompt.confirmed, prompt.uncertain]);
  const empty = { dirty: false, pending: false, needsAttention: false };
  const [observed, setObserved] = useState<{ github: ProjectSettingsSectionState; members: ProjectSettingsSectionState; transfer: ProjectSettingsSectionState; delete: ProjectSettingsSectionState }>({ github: empty, members: empty, transfer: empty, delete: empty });
  const update = useCallback((owner: 'github' | 'members' | 'transfer' | 'delete', value: ProjectSettingsSectionState) => setObserved(previous => {
    const old = previous[owner];
    return old.dirty === value.dirty && old.pending === value.pending && old.needsAttention === value.needsAttention ? previous : { ...previous, [owner]: value };
  }), []);
  const githubState = useCallback((value: ProjectSettingsSectionState) => update('github', value), [update]);
  const membersState = useCallback((value: ProjectSettingsSectionState) => update('members', value), [update]);
  const [memberResultHost, setMemberResultHost] = useState<HTMLDivElement | null>(null);
  const transferState = useCallback((value: ProjectSettingsSectionState) => update('transfer', value), [update]);
  const deletionState = useCallback((value: ProjectSettingsSectionState) => update('delete', value), [update]);
  const states: Record<ProjectSettingsTab, ProjectSettingsSectionState> = {
    execution: { dirty: state.dirty, pending: state.summaryPending, needsAttention: state.invalid || state.draftConflict || state.uncertain || state.reconciliation !== null || state.error !== null || state.writeError !== null },
    prompts: { dirty: prompt.dirty, pending: prompt.pending || prompt.confirmed, needsAttention: prompt.readError !== null || prompt.writeError !== null || prompt.conflict || prompt.uncertain || prompt.invalid || prompt.tooLarge },
    github: observed.github,
    members: observed.members,
    management: { dirty: observed.transfer.dirty || observed.delete.dirty, pending: observed.transfer.pending || observed.delete.pending, needsAttention: observed.transfer.needsAttention || observed.delete.needsAttention },
  };
  const showUnavailable = state.unavailable && unavailableView !== undefined && !guard.isBlocked("delete");
  return <div ref={promptNavigation.owner} onFocusCapture={promptNavigation.rememberFocus}>
    {showUnavailable ? unavailableView : navigation}
    <div ref={setMemberResultHost} />
    <div hidden={showUnavailable} inert={showUnavailable}>
    <div className="page-heading project-settings-heading"><div><div className="eyebrow">{m.eyebrow}</div><h1 tabIndex={-1}>{state.project?.name ?? projectId}</h1><p className="subtitle">{m.scopeHint}</p></div></div>
    {state.error !== null && <ManagementError error={state.error} retry={state.retry} />}
    <div className="project-settings-layout"><ProjectSettingsTabs projectId={projectId} selected={selected} states={states} onSelect={select} />
    <div className="project-settings-content">
    {selection.kind === 'invalid' && <div className="notice error" role="alert">{settingsWorkspaceMessages[locale].invalid} <a href={projectSettingsUrl(projectId, 'execution')} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); select('execution'); }}>{settingsWorkspaceMessages[locale].recover}</a></div>}
    <section id={`project-settings-${projectId}-section-execution`} role="region" aria-labelledby={`project-settings-${projectId}-tab-execution`} hidden={selected !== 'execution'} inert={selected !== 'execution'}>
    <ExecutionSettingsSection state={state} guard={guard} />
    </section>
    <section id={`project-settings-${projectId}-section-prompts`} role="region" aria-labelledby={`project-settings-${projectId}-tab-prompts`} hidden={selected !== 'prompts'} inert={selected !== 'prompts'}><WorkerPromptEditor state={prompt} scope="project" /></section>
    <section id={`project-settings-${projectId}-section-github`} role="region" aria-labelledby={`project-settings-${projectId}-tab-github`} hidden={selected !== 'github'} inert={selected !== 'github'}><GitHubSettings projectId={projectId} userId={user.id} repoUrl={state.project?.repoUrl ?? null} active={sectionActive('github')} onRoute={onRoute} guard={guard} onRetentionChange={onGitHubRetentionChange} onStateChange={githubState} presentationGeneration={generations.current.github} /></section>
    <section id={`project-settings-${projectId}-section-members`} role="region" aria-labelledby={`project-settings-${projectId}-tab-members`} hidden={selected !== 'members'} inert={selected !== 'members'}><MembersPanel projectId={projectId} user={user} projectName={state.project?.name ?? null} active={sectionActive('members')} onRoute={onRoute} onGuardChange={onMemberRetentionChange} onStateChange={membersState} resultHost={memberResultHost} presentationGeneration={generations.current.members} onRemoved={onMemberRemoved ?? (() => {})} onUnavailable={onMemberUnavailable} onMembershipChange={onMembershipChange} /></section>
    <section id={`project-settings-${projectId}-section-management`} role="region" aria-labelledby={`project-settings-${projectId}-tab-management`} hidden={selected !== 'management'} inert={selected !== 'management'}><ProjectOwnership projectId={projectId} projectName={state.project?.name ?? null} onTransferred={onTransferred} active={sectionActive('management')} onRoute={onRoute} unavailable={state.unavailable} onRetentionChange={onRetentionChange} guard={guard} onStateChange={transferState} presentationGeneration={generations.current.management} />
    <ProjectDeletion projectId={projectId} active={sectionActive('management')} onRoute={onRoute} unavailable={state.unavailable} onRetentionChange={onDeletionRetentionChange} guard={guard} onDeleted={onDeleted} onOutcome={onDeletionOutcome} onStateChange={deletionState} presentationGeneration={generations.current.management} /></section>
    </div></div>
    </div>
    {promptNavigation.confirmation}
  </div>;
};
