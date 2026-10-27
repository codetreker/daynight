import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { Project } from "../../api/types";
import { navigate } from "../../app/router";
import { useI18n } from "../../i18n/LocaleProvider";
import { TaskDetailSessionBoundary, useTaskDetailSessions } from "../task-detail/TaskDetailSession";
import { TaskDetailDialog } from "../task-detail/TaskDetailDialog";
import { ProjectOverview } from "./ProjectOverview";
import type { OverviewTaskTarget } from "./overview-progress";
import { useOverviewProgress } from "./useOverviewProgress";
import { taskPageSize, usePagination } from "./usePagination";
import { ProjectSectionTabs } from "./ProjectSectionTabs";
import { ProjectTaskWorkspace } from "./ProjectTaskWorkspace";
import { useChainVisibility, useProjectSection, useStandaloneVisibility, useTaskView, useTaskViewScroll, type ProjectSection, type TaskView } from "./useProjectViewPreferences";
import { ProjectGraphErrorDetail, projectGraphErrorTitle } from "./ProjectGraphError";
import { useTaskGraph } from "./useTaskGraph";
import "../../styles/project.css";

const backToProjects = (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate("/projects");
};

const emptyIds: readonly string[] = [];

type ProjectNotice = { readonly kind: "selected-task-removed" | "overview-target-unavailable" };

const focusVisible = (element: HTMLElement | null | undefined) => {
  if (element == null || !element.isConnected || element.closest('[hidden], [inert]') !== null) return false;
  element.focus();
  return true;
};

const ProjectView = ({ projectId, renderActions }: { readonly projectId: string; readonly renderActions?: (project: Project) => ReactNode }) => {
  const graph = useTaskGraph(projectId);
  const sessions = useTaskDetailSessions();
  useEffect(() => sessions.subscribeProject(projectId, graph.refresh), [sessions, projectId, graph.refresh]);
  const { messages: { workspace: { project: m, projects, app, preferences, overview } }, format } = useI18n();
  const { section, onSectionChange, issue: sectionIssue } = useProjectSection(projectId);
  const [tasksMounted, setTasksMounted] = useState(false);
  const [detailSelection, setDetailSelection] = useState<{ readonly id: string; readonly revision: number } | null>(null);
  const [notice, setNotice] = useState<ProjectNotice | null>(null);
  const [pageNavigation, setPageNavigation] = useState<"overview" | TaskView | null>(null);
  const [overviewTarget, setOverviewTarget] = useState<OverviewTaskTarget | null>(null);
  const highlightedTarget = useRef<{ readonly element: HTMLElement; readonly timer: ReturnType<typeof setTimeout> } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const originalTrigger = useRef<HTMLElement | null>(null);
  const openChain = useRef<string | null>(null);
  const [openChainWitness, setOpenChainWitness] = useState<string | null>(null);
  const currentView = useRef<TaskView>("chains");
  const currentSection = useRef<ProjectSection>(section);
  currentSection.current = section;
  const overviewPosition = useRef(0);
  const snapshot = graph.snapshot;
  const snapshotReady = snapshot !== null;
  const { activeView, onViewChange, issue: tabIssue } = useTaskView(projectId);
  const { savePosition, issue: scrollIssue } = useTaskViewScroll(projectId, activeView, snapshotReady && section === "tasks");
  useLayoutEffect(() => {
    if (!snapshotReady) setTasksMounted(false);
    else if (section === "tasks") setTasksMounted(true);
  }, [snapshotReady, section]);
  useLayoutEffect(() => {
    if (section !== "overview" || !snapshotReady) return;
    window.scrollTo({ top: overviewPosition.current, behavior: "instant" });
  }, [section, snapshotReady]);
  currentView.current = activeView;
  const { showAll, onShowAllChange, issue: visibilityIssue } = useChainVisibility(projectId);
  const { showAll: showAllStandalone, onShowAllChange: onStandaloneVisibilityChange, issue: standaloneIssue } = useStandaloneVisibility(projectId);
  // Database timestamp precision is retained by reversing the server's exact order.
  const categories = useMemo(() => {
    if (snapshot === null) return null;
    const chains = snapshot.index.representativeIds.toReversed().filter((id) => snapshot.index.components.get(id)!.memberIds.size > 1);
    const standalone = snapshot.index.representativeIds.toReversed().filter((id) => snapshot.index.components.get(id)!.memberIds.size === 1);
    let unfinishedChainTaskCount = 0;
    let unfinishedStandaloneTaskCount = 0;
    for (const task of snapshot.index.nodes.values()) {
      if (task.status === "done") continue;
      if (snapshot.index.components.get(snapshot.index.componentByTask.get(task.id)!)!.memberIds.size === 1) unfinishedStandaloneTaskCount++;
      else unfinishedChainTaskCount++;
    }
    return { chains, standalone, unfinishedChainTaskCount, unfinishedStandaloneTaskCount };
  }, [snapshot]);
  const progress = useOverviewProgress(snapshot, categories?.chains ?? emptyIds, categories?.standalone ?? emptyIds, snapshotReady);
  const rootIds = showAll ? categories?.chains ?? emptyIds : progress.chains.map((chain) => chain.taskId);
  const standaloneIds = showAllStandalone ? categories?.standalone ?? emptyIds : progress.recentStandaloneIds;
  const chainPagination = usePagination(rootIds.length);
  const standalonePagination = usePagination(standaloneIds.length);
  const overviewPagination = usePagination(progress.chains.length + (progress.standalone === null ? 0 : 1));
  const pageRootIds = rootIds.slice(chainPagination.start - 1, chainPagination.end);
  const pageStandaloneIds = standaloneIds.slice(standalonePagination.start - 1, standalonePagination.end);
  const selectChainPage = (page: number) => { chainPagination.onPageChange(page); setPageNavigation("chains"); };
  const selectStandalonePage = (page: number) => { standalonePagination.onPageChange(page); setPageNavigation("standalone"); };
  const selectOverviewPage = (page: number) => { overviewPagination.onPageChange(page); setPageNavigation("overview"); };
  const changeChainVisibility = (show: boolean) => { chainPagination.onPageChange(1); onShowAllChange(show); };
  const changeStandaloneVisibility = (show: boolean) => { standalonePagination.onPageChange(1); onStandaloneVisibilityChange(show); };
  useLayoutEffect(() => {
    if (pageNavigation === null) return;
    const id = pageNavigation === "overview" ? "project-overview-progress" : pageNavigation === "chains" ? "project-chain-list" : "project-standalone-list";
    const target = document.getElementById(id);
    if (target !== null && target.closest('[hidden], [inert]') === null) {
      target.scrollIntoView({ block: "start", behavior: "instant" });
      target.focus({ preventScroll: true });
      savePosition();
    }
    setPageNavigation(null);
  }, [pageNavigation, chainPagination.page, standalonePagination.page, overviewPagination.page, savePosition]);
  const representative = openChainWitness === null ? undefined : snapshot?.index.componentByTask.get(openChainWitness);
  const openChainId = section === "tasks" && activeView === "chains" && representative !== undefined && pageRootIds.includes(representative) ? representative : null;
  openChain.current = openChainId;
  useLayoutEffect(() => {
    if (openChainWitness === null || openChainId !== null) return;
    setOpenChainWitness(null);
    if (section !== "tasks") focusVisible(document.getElementById(`project-section-tab-${section}`));
    else if (activeView !== "chains") focusVisible(document.getElementById(`project-task-tab-${activeView}`));
  }, [openChainWitness, openChainId, section, activeView]);
  const onOpenChain = useCallback((id: string) => { setOpenChainWitness(id); }, []);
  const onCloseChain = useCallback(() => { setOpenChainWitness(null); }, []);
  const detailTaskId = detailSelection !== null && snapshot !== null &&
    (detailSelection.revision === snapshot.revision || snapshot.index.nodes.has(detailSelection.id)) ? detailSelection.id : null;

  useEffect(() => {
    if (snapshot === null) return;
    if (detailSelection !== null && detailSelection.revision !== snapshot.revision && !snapshot.index.nodes.has(detailSelection.id)) {
      setDetailSelection(null);
      setNotice({ kind: "selected-task-removed" });
    }
  }, [snapshot, detailSelection]);

  const onOpenTask = useCallback((id: string, trigger: HTMLElement) => {
    originalTrigger.current = trigger;
    setNotice(null);
    setDetailSelection({ id, revision: snapshot!.revision });
  }, [snapshot]);
  const onSelectRelation = useCallback((id: string) => {
    setDetailSelection({ id, revision: snapshot!.revision });
  }, [snapshot]);
  const onClose = useCallback(() => { setDetailSelection(null); }, []);
  const restoreFocus = useCallback(() => {
    if (focusVisible(originalTrigger.current)) return;
    const chainClose = currentView.current !== "chains" || openChain.current === null ? null : document.getElementById(`task-graph-${openChain.current}`)
      ?.querySelector<HTMLButtonElement>('.task-chain-close');
    if (focusVisible(chainClose)) return;
    const root = currentView.current !== "chains" ? null : document.querySelector<HTMLButtonElement>('.root-toggle');
    if (focusVisible(root)) return;
    const standalone = currentView.current === "standalone" ? document.querySelector<HTMLButtonElement>(".standalone-row") : null;
    if (focusVisible(standalone)) return;
    if (focusVisible(document.getElementById(`project-task-tab-${currentView.current}`))) return;
    if (focusVisible(document.getElementById(`project-section-tab-${currentSection.current}`))) return;
    heading.current?.focus();
  }, []);

  const selectView = useCallback((view: TaskView) => {
    if (view === activeView) return;
    savePosition();
    onViewChange(view);
  }, [activeView, savePosition, onViewChange]);

  const selectSection = useCallback((next: ProjectSection) => {
    if (next === section) return;
    if (section === "tasks") savePosition();
    else if (snapshotReady) overviewPosition.current = window.scrollY;
    onSectionChange(next);
  }, [section, savePosition, snapshotReady, onSectionChange]);

  const clearTargetHighlight = useCallback(() => {
    if (highlightedTarget.current === null) return;
    clearTimeout(highlightedTarget.current.timer);
    highlightedTarget.current.element.classList.remove("overview-progress-target");
    highlightedTarget.current = null;
  }, []);
  useEffect(() => clearTargetHighlight, [clearTargetHighlight]);

  const onOverviewNavigate = useCallback((target: OverviewTaskTarget) => {
    setNotice(null);
    setOverviewTarget(target);
    selectView(target.kind === "chain" ? "chains" : "standalone");
    selectSection("tasks");
  }, [selectSection, selectView]);

  useLayoutEffect(() => {
    if (overviewTarget === null || section !== "tasks") return;
    const view = overviewTarget.kind === "chain" ? "chains" : "standalone";
    if (activeView !== view) return;
    const representative = overviewTarget.kind === "chain" ? snapshot?.index.componentByTask.get(overviewTarget.taskId) : undefined;
    const position = representative === undefined ? -1 : rootIds.indexOf(representative);
    const destinationPage = overviewTarget.kind === "standalone" ? 1 : Math.floor(position / taskPageSize) + 1;
    const pagination = overviewTarget.kind === "standalone" ? standalonePagination : chainPagination;
    if (destinationPage > 0 && pagination.page !== destinationPage) {
      pagination.onPageChange(destinationPage);
      return;
    }
    setOverviewTarget(null);
    clearTargetHighlight();
    const target = overviewTarget.kind === "standalone" ? document.getElementById("project-task-panel-standalone")
      : representative !== undefined && position >= 0
        ? document.getElementById(`task-root-${representative}`) : null;
    if (target === null) {
      setNotice({ kind: "overview-target-unavailable" });
      if (!focusVisible(document.getElementById(`project-task-tab-${view}`))) focusVisible(document.getElementById("project-section-tab-tasks"));
      return;
    }
    // Explicit overview navigation runs after the task view restores its saved position.
    target.scrollIntoView({ block: overviewTarget.kind === "chain" ? "center" : "start", behavior: "instant" });
    target.focus({ preventScroll: true });
    savePosition();
    target.classList.add("overview-progress-target");
    highlightedTarget.current = { element: target, timer: setTimeout(clearTargetHighlight, 2_200) };
  }, [overviewTarget, section, activeView, snapshot, rootIds, chainPagination, standalonePagination, savePosition, clearTargetHighlight]);

  return (
    <>
      <div className="project-navigation">
        <a className="back-link" href="/projects" onClick={backToProjects}>{m.back}</a>
        {snapshot !== null && snapshot.receivedAt !== null && (
          <p className="snapshot-time"><time dateTime={new Date(snapshot.receivedAt).toISOString()}>{m.lastRefreshed({ time: format.time(snapshot.receivedAt) })}</time></p>
        )}
      </div>
      <div className="page-heading project-heading">
        <div>
          <p className="eyebrow">{app.projectTasks}</p>
          <h1 ref={heading} tabIndex={-1}>{snapshot === null ? app.projectTasks : snapshot.graph.project.name}</h1>
          {snapshot !== null && <p className="project-repository">{snapshot.graph.project.repoUrl}</p>}
        </div>
        <div className="project-title-actions">{snapshot !== null && renderActions?.(snapshot.graph.project)}<button className="button" type="button" onClick={graph.refresh} disabled={graph.refreshing}>{graph.refreshing ? m.refreshing : projects.refresh}</button></div>
      </div>
      <div className="project-layout">
        <ProjectSectionTabs section={section} onChange={selectSection} />
        <div className="project-section-content">
          {sectionIssue !== null && <p className="snapshot-notice" role="status">{preferences.section[sectionIssue.kind]}</p>}
          {visibilityIssue !== null && <p className="snapshot-notice" role="status">{preferences.completedChains[visibilityIssue.kind]}</p>}
          {tabIssue !== null && <p className="snapshot-notice" role="status">{preferences.tab[tabIssue.kind]}</p>}
          {standaloneIssue !== null && <p className="snapshot-notice" role="status">{preferences.standalone[standaloneIssue.kind]}</p>}
          {scrollIssue !== null && <p className="snapshot-notice" role="status">{preferences.scroll[scrollIssue.kind]}</p>}
          {graph.status === "loading" && (
            <section className="state-box" role="status" aria-label={m.loading}>
              <span className="spinner" aria-hidden="true" /><h2>{m.loading}</h2><p>{m.loadingDetail}</p>
            </section>
          )}
          {graph.status === "error" && (
            <section className="state-box" role="alert">
              <h2>{projectGraphErrorTitle(graph.error, m)}</h2><ProjectGraphErrorDetail error={graph.error} />
              <button className="button primary" type="button" onClick={graph.refresh}>{projects.retry}</button>
              <a className="back-link" href="/projects" onClick={backToProjects}>{app.returnToProjects}</a>
            </section>
          )}
          {snapshot !== null && graph.error !== null && (
            <section className="snapshot-error" role="alert"><h2>{m.refreshFailed}</h2><p>{m.showingSnapshot}</p><ProjectGraphErrorDetail error={graph.error} />
              <button className="button" type="button" onClick={graph.refresh}>{m.retryRefresh}</button>
            </section>
          )}
          {snapshot !== null && notice !== null && <p className="snapshot-notice" role="status">{notice.kind === "selected-task-removed" ? m.selectedTaskRemoved : overview.targetUnavailable}</p>}
          <section className="project-section-panel project-overview" id="project-section-panel-overview" role="tabpanel"
            aria-labelledby="project-section-tab-overview" hidden={section !== "overview"} inert={section !== "overview"} tabIndex={0}>
            {snapshot !== null && <ProjectOverview snapshot={snapshot} progress={progress} pagination={{ ...overviewPagination, onPageChange: selectOverviewPage }} onNavigate={onOverviewNavigate} />}
          </section>
          <section className="project-section-panel project-tasks" id="project-section-panel-tasks" role="tabpanel"
            aria-labelledby="project-section-tab-tasks" hidden={section !== "tasks"} inert={section !== "tasks"} tabIndex={0}>
            {snapshot !== null && (tasksMounted || section === "tasks") && <ProjectTaskWorkspace projectId={projectId} snapshot={snapshot}
              activeView={activeView} unfinishedStandaloneTaskCount={categories!.unfinishedStandaloneTaskCount}
              unfinishedChainTaskCount={categories!.unfinishedChainTaskCount} onViewChange={selectView}
              chains={{ representativeIds: pageRootIds, allRepresentativeIds: categories!.chains, openChainId, onOpenChain, onCloseChain,
                onOpenTask, showAll, onShowAllChange: changeChainVisibility,
                pagination: { ...chainPagination, onPageChange: selectChainPage } }}
              standalone={{ taskIds: pageStandaloneIds, allTaskIds: categories!.standalone, onSelectTask: onOpenTask,
                showAll: showAllStandalone, onShowAllChange: changeStandaloneVisibility,
                pagination: { ...standalonePagination, onPageChange: selectStandalonePage } }} />}
          </section>
        </div>
      </div>
      {snapshot !== null && detailTaskId !== null && <TaskDetailDialog projectId={projectId} taskId={detailTaskId} snapshot={snapshot} onSelectTask={onSelectRelation}
        onClose={onClose} onRestoreFocus={restoreFocus} onRefreshGraph={graph.refresh} />}
    </>
  );
};

export const ProjectPage = ({ projectId, renderActions }: { readonly projectId: string; readonly renderActions?: (project: Project) => ReactNode }) => <TaskDetailSessionBoundary><ProjectView key={projectId} projectId={projectId} {...(renderActions === undefined ? {} : { renderActions })} /></TaskDetailSessionBoundary>;
