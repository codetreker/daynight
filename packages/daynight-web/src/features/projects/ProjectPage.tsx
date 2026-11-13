import { isTerminalStatus } from "../../api/task-status";
import { ProjectAccessBoundary, useProjectAccess } from "./ProjectAccess";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { GraphTask, Project, TaskStatus } from "../../api/types";
import { navigate, taskDetailUrl } from "../../app/router";
import { browserNavigation } from "../../app/navigation";
import { useProjectHistory } from "../../app/use-page-history";
import { ProjectDraftHost } from "../task-detail/TaskDraftNavigation";
import { OverlayOwnerContext } from "../../app/overlay";
import { canonicalId } from "../../api/validation";
import { useI18n } from "../../i18n/LocaleProvider";
import { TaskDetailSessionBoundary, useTaskDetailSessions } from "../task-detail/TaskDetailSession";
import { TaskDetailDialog } from "../task-detail/TaskDetailDialog";
import { TaskExecutionClockProvider } from "../task-execution/TaskExecutionClock";
import { TaskOrganization } from "../task-detail/TaskOrganization";
import { projectTaskScope } from "../task-graph/scope";
import { ProjectOverview } from "./ProjectOverview";
import type { OverviewTaskTarget } from "./overview-progress";
import { useOverviewProgress } from "./useOverviewProgress";
import { taskPageSize, usePagination } from "./usePagination";
import { ProjectSectionTabs } from "./ProjectSectionTabs";
import { ProjectTaskWorkspace } from "./ProjectTaskWorkspace";
import { focusProjectList, focusVisible, type ProjectListOrigin } from "./project-list-focus";
import { resolveProjectGraphTarget, type ProjectGraphTarget } from "./project-graph-target";
import { useProjectAssigneeFilter, useProjectSection, useTaskView, useTaskListScroll, type ProjectSection, type TaskView } from "./useProjectViewPreferences";
import { ProjectGraphErrorDetail, projectGraphErrorTitle } from "./ProjectGraphError";
import { useTaskGraph } from "./useTaskGraph";
import { useProjectPageRead } from "./useProjectPageRead";
import { compareTaskStatus } from "./task-order";
import { useTaskCacheScope } from "../task-cache/TaskCacheProvider";
import { useProjectAssigneeReceipt } from "../task-assignees/TaskAssignees";
import { TaskAssigneeFilter, matchesAssignee, type AssigneeFilter } from "../task-assignment/TaskAssigneeFilter";
import { pausedSummaryTaskIds } from "../task-pause/paused-summary";
import { TaskSearchWorkspace, assigneeValue } from "../task-search/TaskSearchWorkspace";
import { useTaskSearch } from "../task-search/useTaskSearch";
import { ProjectTags } from "../task-tags/ProjectTags";
import { PullRequestWorkspace } from "../pull-requests/PullRequestWorkspace";
import "../../styles/project.css";

const backToProjects = (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate("/projects");
};

const emptyIds: readonly string[] = [];

type ProjectNotice = { readonly kind: "selected-task-removed" | "overview-target-unavailable" };

const visibleTaskFilters = (tasks: readonly GraphTask[], assignee: AssigneeFilter, status: TaskStatus | "all", userId: string, every: boolean) => {
  const assigneeMatches = (task: GraphTask) => matchesAssignee(task.assignedTo, assignee, userId);
  const statusMatches = (task: GraphTask) => status === "all" || task.status === status;
  if (every) return {
    assignee: tasks.every(assigneeMatches) ? assignee : { kind: "all" } as const,
    status: tasks.every(statusMatches) ? status : "all" as const,
  };
  if (tasks.some((task) => assigneeMatches(task) && statusMatches(task))) return { assignee, status };
  if (tasks.some(assigneeMatches)) return { assignee, status: "all" as const };
  if (tasks.some(statusMatches)) return { assignee: { kind: "all" } as const, status };
  return { assignee: { kind: "all" } as const, status: "all" as const };
};

const ProjectView = ({ projectId, renderActions }: { readonly projectId: string; readonly renderActions?: (project: Project) => ReactNode }) => {
  const graph = useTaskGraph(projectId);
  const projectRead = useProjectPageRead(projectId);
  const projectAccess = useProjectAccess(projectId);
  const graphOwner = useRef(Symbol());
  useProjectAssigneeReceipt(projectId, graphOwner.current, graph.snapshot?.revision ?? 0);
  const viewer = useTaskCacheScope();
  const { filter: assigneeFilter, onFilterChange: setAssigneeFilter, issue: assigneeIssue } = useProjectAssigneeFilter(projectId, viewer.userId);
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const sessions = useTaskDetailSessions();
  useEffect(() => sessions.subscribeProject(projectId, graph.refresh), [sessions, projectId, graph.refresh]);
  const { locale, messages: { workspace: { project: m, projects, app, preferences, overview }, auth: { shell: auth } }, format } = useI18n();
  const { section: preferredSection, onSectionChange, issue: sectionIssue } = useProjectSection(projectId);
  const { activeView: preferredView, onViewChange, issue: tabIssue } = useTaskView(projectId);
  const history = useProjectHistory(viewer.userId, projectId, true, { section: preferredSection, view: preferredView }, viewer);
  const selection = history.selection;
  const { section, view: activeView, projectGraphWitness: graphWitness, detail: detailSelection } = selection;
  const [tasksMounted, setTasksMounted] = useState(false);
  const [tagsMounted, setTagsMounted] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const search = useTaskSearch(projectId, viewer, assigneeValue(assigneeFilter));
  const searchActive = search.applied !== null;
  const [notice, setNotice] = useState<ProjectNotice | null>(null);
  const [pageNavigation, setPageNavigation] = useState<"overview" | TaskView | null>(null);
  const [navigationWitness, setNavigationWitness] = useState<string | null>(null);
  const [revealTaskId, setRevealTaskId] = useState<string | null>(null);
  const [listTarget, setListTarget] = useState<OverviewTaskTarget | null>(null);
  const highlightedTarget = useRef<{ readonly element: HTMLElement; readonly timer: ReturnType<typeof setTimeout> } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const originalTrigger = useRef<HTMLElement | null>(null);
  const listOrigin = useRef<ProjectListOrigin | null>(null);
  const lastGraphResource = useRef<string | null>(null);
  const restoreRequested = useRef(false);
  const previousDetail = useRef(detailSelection);
  const closedDetail = useRef(detailSelection);
  const pendingRetirement = useRef<{ summaryId: string | null } | null>(null);
  const currentSelection = useRef(selection);
  currentSelection.current = selection;
  useLayoutEffect(() => viewer.subscribe((event) => {
    if (event.projectId !== projectId) return;
    if (event.accessRevoked) { pendingRetirement.current = null; return; }
    if (event.historyChanged && (currentSelection.current.detail !== null || currentSelection.current.projectGraphWitness !== null)) {
      const detail = currentSelection.current.detail;
      pendingRetirement.current = { summaryId: detail?.source === "summary" ? detail.id : null };
      listOrigin.current = null; originalTrigger.current = null; lastGraphResource.current = null; closedDetail.current = null;
    }
  }), [viewer, projectId]);
  const suppressRestore = useRef(false);
  if (previousDetail.current !== null && detailSelection === null) {
    closedDetail.current = previousDetail.current;
    if (!suppressRestore.current) restoreRequested.current = true;
    suppressRestore.current = false;
  }
  previousDetail.current = detailSelection;
  const searchTrigger = useRef(false);
  const openGraph = useRef<ProjectGraphTarget | null>(null);
  const [chainOverlay, setChainOverlay] = useState<HTMLElement | null>(null);
  const currentView = useRef<TaskView>("chains");
  const currentSection = useRef<ProjectSection>(section);
  currentSection.current = section;
  const overviewPosition = useRef(0);
  const prPosition = useRef(0);
  const snapshot = graph.snapshot;
  const snapshotReady = snapshot !== null;
  const { savePosition, issue: scrollIssue } = useTaskListScroll(projectId, snapshotReady && section === "tasks" && !searchActive);
  useLayoutEffect(() => {
    if (!snapshotReady) setTasksMounted(false);
    else if (section === "tasks") setTasksMounted(true);
  }, [snapshotReady, section]);
  useLayoutEffect(() => { if (section === "tags") setTagsMounted(true); }, [section]);
  useLayoutEffect(() => {
    if (section !== "overview" || !snapshotReady) return;
    window.scrollTo({ top: overviewPosition.current, behavior: "instant" });
  }, [section, snapshotReady]);
  useLayoutEffect(() => {
    if (section === "prs") window.scrollTo({ top: prPosition.current, behavior: "instant" });
  }, [section]);
  currentView.current = activeView;
  const categories = useMemo(() => {
    if (snapshot === null) return null;
    // Stable status sorting preserves the reversed server order's timestamp precision.
    const ordered = snapshot.index.representativeIds.toReversed().sort((left, right) => compareTaskStatus(
      snapshot.index.components.get(left)!.progress.status, snapshot.index.components.get(right)!.progress.status));
    const chains = ordered.filter((id) => snapshot.index.components.get(id)!.memberIds.size > 1);
    const standalone = ordered.filter((id) => snapshot.index.components.get(id)!.memberIds.size === 1);
    return { chains, standalone };
  }, [snapshot]);
  const progress = useOverviewProgress(snapshot, categories?.chains ?? emptyIds, categories?.standalone ?? emptyIds, snapshotReady);
  const scope = useMemo(() => snapshot === null ? null : projectTaskScope(snapshot.index, null), [snapshot]);
  const scopedMembers = useMemo(() => new Map(scope?.chains.map((chain) => [chain.representativeId, chain.memberIds]) ?? []), [scope]);
  const allGoals = useMemo(() => snapshot === null ? [] : [...snapshot.summaries.values()].filter((item) => item.type === "goal")
    .toReversed().sort((left, right) => compareTaskStatus(left.status, right.status)), [snapshot]);
  const matchesCurrentAssignee = (assignedTo: string | null) => matchesAssignee(assignedTo, assigneeFilter, viewer.userId);
  const assignedGoals = allGoals.filter((goal) => matchesCurrentAssignee(goal.assignedTo));
  const goals = assignedGoals.filter((goal) =>
    (statusFilter === "all" || goal.status === statusFilter));
  const pausedTaskCount = useMemo(() => snapshot === null ? 0 : pausedSummaryTaskIds(
    snapshot.graph.tasks.filter((task) => matchesAssignee(task.assignedTo, assigneeFilter, viewer.userId)), snapshot.pausedTaskIds).size,
  [snapshot, assigneeFilter, viewer.userId]);
  const matchingTaskIds = useMemo(() => snapshot === null ? new Set<string>()
    : new Set([...snapshot.index.nodes.values()].filter((task) => matchesAssignee(task.assignedTo, assigneeFilter, viewer.userId) &&
      (statusFilter === "all" || task.status === statusFilter)).map((task) => task.id)), [snapshot, assigneeFilter, statusFilter, viewer.userId]);
  const scopedChainIds = (categories?.chains ?? emptyIds).filter((id) => scopedMembers.has(id));
  const scopedStandaloneIds = (categories?.standalone ?? emptyIds).filter((id) => scope?.standaloneIds.includes(id));
  const unfinishedMatches = (id: string) => {
    const task = snapshot!.index.nodes.get(id)!;
    return !isTerminalStatus(task.status) && matchesCurrentAssignee(task.assignedTo);
  };
  const unfinishedStandaloneTaskCount = scopedStandaloneIds.filter(unfinishedMatches).length;
  const unfinishedChainTaskCount = [...new Set([...scopedMembers.values()].flat())].filter(unfinishedMatches).length;
  const rootIds = scopedChainIds.filter((id) => scopedMembers.get(id)!.some((member) => matchingTaskIds.has(member)));
  const standaloneIds = scopedStandaloneIds.filter((id) => matchingTaskIds.has(id));
  const chainPagination = usePagination(rootIds.length);
  const standalonePagination = usePagination(standaloneIds.length);
  const goalPagination = usePagination(goals.length);
  const overviewPagination = usePagination(progress.chains.length + (progress.standalone === null ? 0 : 1), 20);
  const pageRootIds = rootIds.slice(chainPagination.start - 1, chainPagination.end);
  const pageStandaloneIds = standaloneIds.slice(standalonePagination.start - 1, standalonePagination.end);
  const pageGoals = goals.slice(goalPagination.start - 1, goalPagination.end);
  const selectChainPage = (page: number) => { chainPagination.onPageChange(page); setPageNavigation("chains"); };
  const selectStandalonePage = (page: number) => { standalonePagination.onPageChange(page); setPageNavigation("standalone"); };
  const changeAssigneeFilter = (filter: AssigneeFilter) => { chainPagination.onPageChange(1); standalonePagination.onPageChange(1); goalPagination.onPageChange(1); setAssigneeFilter(filter); };
  const changeStatusFilter = (filter: TaskStatus | "all") => { chainPagination.onPageChange(1); standalonePagination.onPageChange(1); goalPagination.onPageChange(1); setStatusFilter(filter); };
  const selectOverviewPage = (page: number) => { overviewPagination.onPageChange(page); setPageNavigation("overview"); };
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
  if (graphWitness !== null) lastGraphResource.current = graphWitness;
  const openGraphTarget = section === "tasks" && (activeView === "chains" || activeView === "goals")
    ? resolveProjectGraphTarget(graphWitness, snapshot?.index ?? null, activeView === "goals" ? snapshot?.summaries : undefined) : null;
  openGraph.current = openGraphTarget;
  useLayoutEffect(() => {
    if (graphWitness === null || snapshot === null || snapshot.receivedAt === null || openGraphTarget !== null) return;
    history.select({ ...selection, projectGraphWitness: null }, true);
    if (section !== "tasks") focusVisible(document.getElementById(`project-section-tab-${section}`));
    else if (activeView !== "chains" && activeView !== "goals") focusVisible(document.getElementById(`project-task-tab-${activeView}`));
  }, [graphWitness, openGraphTarget, section, activeView, snapshot, selection, history.select]);
  const onOpenListChain = useCallback((id: string, trigger: HTMLElement, sourceGoalId: string | null) => {
    history.select({ ...selection, projectGraphWitness: id }, false, () => {
      listOrigin.current = { view: activeView, sourceGoalId, resourceWitness: id, trigger };
      restoreRequested.current = false; originalTrigger.current = null; searchTrigger.current = false;
    });
  }, [activeView, history.select, selection]);
  const onOpenGoalGraph = useCallback((id: string, trigger: HTMLElement) => onOpenListChain(id, trigger, id), [onOpenListChain]);
  const onCloseChain = useCallback(() => { history.select({ ...selection, projectGraphWitness: null }, true); }, [history.select, selection]);

  const selectedSummary = useRef<{ id: string; revision: number } | null>(null);
  if (detailSelection === null || detailSelection.source !== "summary") selectedSummary.current = null;
  else if (snapshot !== null && selectedSummary.current?.id !== detailSelection.id) selectedSummary.current = { id: detailSelection.id, revision: snapshot.revision };
  useEffect(() => {
    if (snapshot === null || detailSelection === null || detailSelection.source !== "summary" || selectedSummary.current?.revision === snapshot.revision || snapshot.summaries.has(detailSelection.id)) return;
    history.select({ ...selection, detail: null }, true, () => {
      restoreRequested.current = true;
      setNotice({ kind: "selected-task-removed" });
    });
  }, [snapshot, detailSelection, selection, history.select]);

  const onOpenTask = useCallback((id: string, trigger: HTMLElement) => {
    history.select({ ...selection, detail: { id, source: "summary", insideProjectGraph: trigger.closest(".task-chain-dialog") !== null,
      navigation: { tab: "overview", path: null }, goalChildren: null } }, false, () => {
      restoreRequested.current = false; originalTrigger.current = trigger; searchTrigger.current = false; setNotice(null);
    });
  }, [history.select, selection]);
  const onOpenListTask = useCallback((id: string, trigger: HTMLElement, sourceGoalId: string | null) => {
    history.select({ ...selection, detail: { id, source: "summary", insideProjectGraph: false,
      navigation: { tab: "overview", path: null }, goalChildren: null } }, false, () => {
      listOrigin.current = { view: activeView, sourceGoalId, resourceWitness: id, trigger };
      restoreRequested.current = false; originalTrigger.current = null; searchTrigger.current = false; setNotice(null);
    });
  }, [activeView, history.select, selection]);
  const onOpenSearchTask = useCallback((id: string, trigger: HTMLElement) => {
    history.select({ ...selection, detail: { id, source: "direct", insideProjectGraph: false,
      navigation: { tab: "overview", path: null }, goalChildren: null } }, false, () => {
      restoreRequested.current = false; listOrigin.current = null; originalTrigger.current = trigger; searchTrigger.current = true; setNotice(null);
    });
  }, [history.select, selection]);
  const onOpenSession = useCallback((id: string) => {
    navigate(taskDetailUrl(projectId, id, { tab: "session", path: null }));
  }, [projectId]);
  const onSelectRelation = useCallback((id: string) => {
    history.select({ ...selection, detail: { id, source: detailSelection?.source === "direct" || snapshot === null ? "direct" : "summary",
      insideProjectGraph: detailSelection?.insideProjectGraph ?? false, navigation: { tab: "overview", path: null }, goalChildren: null } }, false);
  }, [history.select, selection, detailSelection, snapshot]);
  const onClose = useCallback(() => { history.select({ ...selection, detail: null }, true, () => { restoreRequested.current = true; }); }, [history.select, selection]);
  const projectMounted = useRef(true);
  useLayoutEffect(() => { projectMounted.current = true; return () => { projectMounted.current = false; }; }, []);
  const indexForFocus = useRef(snapshot?.index ?? null);
  indexForFocus.current = snapshot?.index ?? null;
  const summariesForFocus = useRef(snapshot?.summaries);
  summariesForFocus.current = snapshot?.summaries;
  const restoreFocus = useCallback(() => {
    if (!restoreRequested.current || pendingRetirement.current !== null || previousDetail.current !== null) return;
    const trigger = originalTrigger.current;
    const fromSearch = searchTrigger.current;
    const origin = listOrigin.current;
    const focus = () => {
      if (!projectMounted.current || previousDetail.current !== null) return false;
      if (openGraph.current !== null) {
        if (focusVisible(trigger)) return true;
        return focusVisible(document.getElementById(`task-graph-${openGraph.current.kind === "chain" ? openGraph.current.rootId : openGraph.current.goalId}`)?.querySelector<HTMLButtonElement>('.task-chain-close'));
      }
      if (fromSearch && (focusVisible(trigger) || focusVisible(searchInput.current))) return true;
      if (origin === null && focusVisible(trigger)) return true;
      const detailWitness = !fromSearch && closedDetail.current?.source === "summary" && !closedDetail.current.insideProjectGraph ? closedDetail.current.id : null;
      if (focusProjectList(currentView.current, origin, resolveProjectGraphTarget(lastGraphResource.current, indexForFocus.current, summariesForFocus.current), indexForFocus.current, lastGraphResource.current, detailWitness)) return true;
      if (focusVisible(document.getElementById(`project-task-tab-${currentView.current}`))) return true;
      if (focusVisible(document.getElementById(`project-section-tab-${currentSection.current}`))) return true;
      return focusVisible(heading.current);
    };
    const finish = () => {
      if (!restoreRequested.current || pendingRetirement.current !== null || !focus()) return;
      restoreRequested.current = false;
      originalTrigger.current = null;
      searchTrigger.current = false;
      if (openGraph.current === null) { listOrigin.current = null; lastGraphResource.current = null; }
    };
    // Overlay cleanups can release inertness after the detail or graph unmounts.
    finish();
    if (restoreRequested.current) queueMicrotask(finish);
  }, []);
  const restoreGraphFocus = useCallback(() => {
    if (currentSelection.current.detail !== null || openGraph.current !== null) return;
    restoreRequested.current = true;
    restoreFocus();
  }, [restoreFocus]);
  useEffect(() => {
    const retired = pendingRetirement.current;
    if (retired === null || snapshot === null) return;
    pendingRetirement.current = null;
    if (retired.summaryId !== null && !snapshot.summaries.has(retired.summaryId)) setNotice({ kind: "selected-task-removed" });
    restoreRequested.current = true;
    restoreFocus();
  }, [snapshot, restoreFocus]);

  const selectView = useCallback((view: TaskView) => {
    if (view === activeView) return;
    history.select({ ...selection, view, projectGraphWitness: null }, false, () => onViewChange(view));
  }, [activeView, history.select, selection, onViewChange]);

  const saveSectionPosition = useCallback(() => {
    if (section === "tasks") savePosition();
    else if (section === "overview" && snapshotReady) overviewPosition.current = window.scrollY;
    else if (section === "prs") prPosition.current = window.scrollY;
  }, [section, savePosition, snapshotReady]);

  const selectSection = useCallback((next: ProjectSection) => {
    if (next === section) return;
    history.select({ ...selection, section: next, projectGraphWitness: null }, false, () => {
      saveSectionPosition();
      onSectionChange(next);
    });
  }, [section, saveSectionPosition, onSectionChange, history.select, selection]);

  const clearTargetHighlight = useCallback(() => {
    if (highlightedTarget.current === null) return;
    clearTimeout(highlightedTarget.current.timer);
    highlightedTarget.current.element.classList.remove("overview-progress-target");
    highlightedTarget.current = null;
  }, []);
  useEffect(() => clearTargetHighlight, [clearTargetHighlight]);


  const onNavigateExternalTask = useCallback((id: string, trigger: HTMLElement) => {
    const task = snapshot?.index.nodes.get(id);
    if (snapshot === null || task === undefined) { setNotice({ kind: "overview-target-unavailable" }); return; }
    if (task.parentId === null && detailSelection === null && (activeView === "chains" || activeView === "goals") && openGraphTarget !== null) {
      const representative = snapshot.index.componentByTask.get(id)!;
      if (snapshot.index.components.get(representative)!.memberIds.size === 1) {
        history.select({ ...selection, projectGraphWitness: null, detail: { id, source: "summary", insideProjectGraph: false,
          navigation: { tab: "overview", path: null }, goalChildren: null } }, false, () => {
          restoreRequested.current = false; originalTrigger.current = null; searchTrigger.current = false; setNotice(null);
        });
      } else history.select({ ...selection, projectGraphWitness: id });
      return;
    }
    if (task.parentId !== null) {
      if (snapshot.summaries.get(task.parentId)?.type !== "goal") { setNotice({ kind: "overview-target-unavailable" }); return; }
      const insideProjectGraph = detailSelection?.insideProjectGraph === true || openGraphTarget !== null && trigger.closest(".task-chain-dialog") !== null;
      const goalId = task.parentId;
      history.select({ ...selection, detail: { id: goalId, source: "summary", insideProjectGraph,
        navigation: { tab: "description", path: null }, goalChildren: { graphRootId: null, task: { id, navigation: { tab: "overview", path: null } } } } }, false, () => {
        if (originalTrigger.current === null) originalTrigger.current = trigger;
        setNotice(null);
      });
      return;
    }
    const representative = snapshot.index.componentByTask.get(id)!;
    const view = snapshot.index.components.get(representative)!.memberIds.size === 1 ? "standalone" : "chains";
    const commit = () => {
      if (detailSelection !== null) suppressRestore.current = true;
      if (originalTrigger.current === null) originalTrigger.current = trigger;
      if (search.applied !== null) search.clear();
      setNotice(null); setAssigneeFilter({ kind: "all" }); setStatusFilter("all");
      if (section !== "tasks") { saveSectionPosition(); onSectionChange("tasks"); }
      if (view !== activeView) onViewChange(view);
      setNavigationWitness(id);
    };
    if (section === "tasks" && activeView === view && graphWitness === null && detailSelection === null) commit();
    else history.select({ ...selection, section: "tasks", view, projectGraphWitness: null, detail: null }, false, commit);
  }, [snapshot, detailSelection, activeView, openGraphTarget, graphWitness, history.select, selection, search.applied, search.clear, setAssigneeFilter, section, saveSectionPosition, onSectionChange, onViewChange]);

  const onNavigateExternalChain = useCallback((id: string, trigger: HTMLElement) => {
    const task = snapshot?.index.nodes.get(id);
    if (snapshot === null || task === undefined) { setNotice({ kind: "overview-target-unavailable" }); return; }
    const representative = snapshot.index.componentByTask.get(id)!;
    if (snapshot.index.components.get(representative)!.memberIds.size === 1) {
      if (task.parentId !== null) onNavigateExternalTask(id, trigger);
      else history.select({ ...selection, projectGraphWitness: null, detail: { id, source: "summary", insideProjectGraph: false,
        navigation: { tab: "overview", path: null }, goalChildren: null } }, false, () => {
        restoreRequested.current = false;
        if (originalTrigger.current === null) originalTrigger.current = trigger;
        searchTrigger.current = false; setNotice(null);
      });
      return;
    }
    if (task.parentId !== null) {
      if (snapshot.summaries.get(task.parentId)?.type !== "goal") { setNotice({ kind: "overview-target-unavailable" }); return; }
      const insideProjectGraph = detailSelection?.insideProjectGraph === true || openGraphTarget !== null && trigger.closest(".task-chain-dialog") !== null;
      history.select({ ...selection, detail: { id: task.parentId, source: "summary", insideProjectGraph,
        navigation: { tab: "description", path: null }, goalChildren: { graphRootId: representative, task: null } } }, false, () => {
        if (originalTrigger.current === null) originalTrigger.current = trigger;
        setNotice(null);
      });
    } else {
      const view = activeView === "goals" ? "goals" : "chains";
      history.select({ ...selection, section: "tasks", view, projectGraphWitness: id, detail: null }, false, () => {
        if (detailSelection !== null) suppressRestore.current = true;
        if (originalTrigger.current === null) originalTrigger.current = trigger;
        setNotice(null);
        if (section !== "tasks") { saveSectionPosition(); onSectionChange("tasks"); }
        if (activeView !== view) onViewChange(view);
      });
    }
  }, [snapshot, onNavigateExternalTask, detailSelection, openGraphTarget, history.select, selection, activeView, section, saveSectionPosition, onSectionChange, onViewChange]);

  const onOpenChainTask = useCallback((id: string, trigger: HTMLElement) => {
    if (trigger.closest(".task-chain-dialog") !== null && snapshot?.index.nodes.get(id)?.parentId != null) onNavigateExternalTask(id, trigger);
    else onOpenTask(id, trigger);
  }, [snapshot, onNavigateExternalTask, onOpenTask]);

  const onOverviewNavigate = useCallback((target: OverviewTaskTarget) => {
    if (target.kind === "chain" && snapshot?.index.nodes.get(target.taskId)?.parentId != null) {
      onNavigateExternalTask(target.taskId, document.activeElement instanceof HTMLElement ? document.activeElement : heading.current!);
      return;
    }
    const view = target.kind === "chain" ? "chains" : "standalone";
    history.select({ ...selection, section: "tasks", view, projectGraphWitness: null }, false, () => {
      if (search.applied !== null) search.clear();
      setNotice(null);
      if (snapshot !== null) {
        const ids = target.kind === "standalone" ? progress.recentStandaloneIds
          : [...(snapshot.index.components.get(snapshot.index.componentByTask.get(target.taskId) ?? "")?.memberIds ?? [])];
        const tasks = ids.map((id) => snapshot.index.nodes.get(id)!).filter((task) => task !== undefined && task.parentId === null);
        const filters = visibleTaskFilters(tasks, assigneeFilter, statusFilter, viewer.userId, target.kind === "standalone");
        if (filters.assignee !== assigneeFilter || filters.status !== statusFilter) {
          chainPagination.onPageChange(1); standalonePagination.onPageChange(1);
          if (filters.assignee !== assigneeFilter) setAssigneeFilter(filters.assignee);
          setStatusFilter(filters.status);
        }
      }
      setListTarget(target);
      if (view !== activeView) onViewChange(view);
      if (section !== "tasks") { saveSectionPosition(); onSectionChange("tasks"); }
    });
  }, [history.select, selection, snapshot, progress.recentStandaloneIds, assigneeFilter, setAssigneeFilter, statusFilter, viewer.userId, chainPagination.onPageChange, standalonePagination.onPageChange, search.applied, search.clear, onNavigateExternalTask, activeView, onViewChange, section, saveSectionPosition, onSectionChange]);

  useEffect(() => {
    if (snapshot === null || (!window.location.hash.startsWith("#task=") && !window.location.hash.startsWith("#chain="))) return;
    const chain = window.location.hash.startsWith("#chain=");
    const value = new URLSearchParams(window.location.hash.slice(1)).get(chain ? "chain" : "task");
    const id = value === null ? null : canonicalId(value);
    browserNavigation().clearFragment();
    if (id === null || !snapshot.index.nodes.has(id)) { setNotice({ kind: "overview-target-unavailable" }); return; }
    if (chain) onNavigateExternalChain(id, heading.current!);
    else onNavigateExternalTask(id, heading.current!);
  }, [snapshot, onNavigateExternalTask, onNavigateExternalChain]);

  useLayoutEffect(() => {
    if (navigationWitness === null || snapshot === null || section !== "tasks") return;
    const representative = snapshot.index.componentByTask.get(navigationWitness);
    if (representative === undefined) { setNavigationWitness(null); setNotice({ kind: "overview-target-unavailable" }); return; }
    const chain = snapshot.index.components.get(representative)!.memberIds.size > 1;
    if (activeView !== (chain ? "chains" : "standalone")) return;
    const ids = chain ? rootIds : standaloneIds;
    const position = ids.indexOf(chain ? representative : navigationWitness);
    if (position < 0) return;
    const pagination = chain ? chainPagination : standalonePagination;
    const page = Math.floor(position / taskPageSize) + 1;
    if (pagination.page !== page) { pagination.onPageChange(page); return; }
    if (chain) setRevealTaskId(navigationWitness);
    else {
      const target = document.getElementById(`standalone-task-${navigationWitness}`);
      if (target === null) return;
      target.scrollIntoView({ block: "center", behavior: "instant" });
      target.focus({ preventScroll: true });
    }
    setNavigationWitness(null);
  }, [navigationWitness, snapshot, section, activeView, rootIds, standaloneIds, chainPagination, standalonePagination]);

  useLayoutEffect(() => {
    if (listTarget === null || section !== "tasks") return;
    const view = listTarget.kind === "chain" ? "chains" : "standalone";
    if (activeView !== view) return;
    const representative = listTarget.kind === "chain" ? snapshot?.index.componentByTask.get(listTarget.taskId) : undefined;
    const position = representative === undefined ? -1 : rootIds.indexOf(representative);
    const destinationPage = listTarget.kind === "standalone" ? 1 : Math.floor(position / taskPageSize) + 1;
    const pagination = listTarget.kind === "standalone" ? standalonePagination : chainPagination;
    if (destinationPage > 0 && pagination.page !== destinationPage) {
      pagination.onPageChange(destinationPage);
      return;
    }
    setListTarget(null);
    clearTargetHighlight();
    const target = listTarget.kind === "standalone" ? document.getElementById("project-task-panel-standalone")
      : representative !== undefined && position >= 0
        ? document.getElementById(`task-root-${representative}`) : null;
    if (target === null) {
      setNotice({ kind: "overview-target-unavailable" });
      if (!focusVisible(document.getElementById(`project-task-tab-${view}`))) focusVisible(document.getElementById("project-section-tab-tasks"));
      return;
    }
    // Explicit overview navigation runs after the task list restores its saved position.
    target.scrollIntoView({ block: listTarget.kind === "chain" ? "center" : "start", behavior: "instant" });
    target.focus({ preventScroll: true });
    savePosition();
    target.classList.add("overview-progress-target");
    highlightedTarget.current = { element: target, timer: setTimeout(clearTargetHighlight, 2_200) };
  }, [listTarget, section, activeView, snapshot, rootIds, chainPagination, standalonePagination, savePosition, clearTargetHighlight]);

  const detailInsideGraph = detailSelection?.source === "summary" && detailSelection.insideProjectGraph === true && openGraphTarget !== null;
  const detailOwner = useMemo(() => detailInsideGraph && chainOverlay !== null
    ? { current: chainOverlay } : null, [detailInsideGraph, chainOverlay]);
  const detailDialog = detailSelection === null ? null : <ProjectDraftHost projectId={projectId} taskId={detailSelection.id} source={detailSelection.source} summaryType={snapshot === null ? undefined : snapshot.summaries.get(detailSelection.id)?.type ?? null} insideProjectGraph={detailSelection.insideProjectGraph} graphWitness={selection.projectGraphWitness}><TaskDetailDialog projectId={projectId} taskId={detailSelection.id} snapshot={snapshot} observation={detailSelection.source === "direct" ? { kind: "direct" } : { kind: "project-summary", revision: snapshot?.revision ?? 0, task: snapshot?.index.nodes.get(detailSelection.id) }} onSelectTask={onSelectRelation}
    navigation={detailSelection.navigation} onNavigate={(navigation) => history.select({ ...selection, detail: { ...detailSelection, navigation } })}
    goalChildren={detailSelection.goalChildren ?? { graphRootId: null, task: null }} onGoalChildrenChange={(goalChildren, options) => history.select({ ...selection, detail: { ...detailSelection, goalChildren } }, options?.replace)}
    onClose={onClose} onRestoreFocus={restoreFocus} onRefreshGraph={graph.refresh} goalGraphError={graph.error} onNavigateExternalTask={onNavigateExternalTask} onNavigateExternalChain={onNavigateExternalChain} /></ProjectDraftHost>;

  const graphState = <>
    {graph.status === "loading" && <section className="state-box" role="status" aria-label={m.loading}>
      <span className="spinner" aria-hidden="true" /><h2>{m.loading}</h2><p>{m.loadingDetail}</p>
    </section>}
    {graph.status === "error" && <section className="state-box" role="alert">
      <h2>{projectGraphErrorTitle(graph.error, m)}</h2><ProjectGraphErrorDetail error={graph.error} />
      <button className="button primary" type="button" onClick={graph.refresh}>{projects.retry}</button>
      <a className="back-link" href="/projects" onClick={backToProjects}>{app.returnToProjects}</a>
    </section>}
    {snapshot !== null && graph.error !== null && <section className="snapshot-error" role="alert"><h2>{m.refreshFailed}</h2><p>{m.showingSnapshot}</p><ProjectGraphErrorDetail error={graph.error} />
      <button className="button" type="button" onClick={graph.refresh}>{m.retryRefresh}</button>
    </section>}
  </>;

  return (
    <TaskExecutionClockProvider projectId={projectId} snapshot={snapshot}>
      {history.error && <div className="notice error" role="alert">{locale === "zh-CN" ? "页面导航状态无效。" : "Invalid page navigation state."}</div>}
      <div hidden={history.error} inert={history.error}>
      <div className="project-navigation">
        <a className="back-link" href="/projects" onClick={backToProjects}>{m.back}</a>
        {snapshot !== null && snapshot.receivedAt !== null && (
          <p className="snapshot-time"><time dateTime={new Date(snapshot.receivedAt).toISOString()}>{m.lastRefreshed({ time: format.time(snapshot.receivedAt) })}</time></p>
        )}
      </div>
      <div className="page-heading project-heading">
        <div>
          <p className="eyebrow">{app.projectTasks}</p>
          <div className="project-title-line">
            <h1 ref={heading} tabIndex={-1}>{projectRead.project?.name ?? app.projectTasks}</h1>
            {projectRead.project !== null && <p className="project-repository">{projectRead.project.repoUrl}</p>}
          </div>
        </div>
        <div className="project-title-actions">{projectRead.project !== null ? renderActions?.(projectRead.project) : renderActions !== undefined && <span className="project-title-actions-placeholder" aria-hidden="true"><span className="button">{auth.members}</span><span className="button">{auth.projectSettings}</span></span>}<button className="button" type="button" onClick={graph.refresh} disabled={graph.refreshing}>{graph.refreshing ? m.refreshing : projects.refresh}</button><TaskOrganization projectId={projectId} snapshot={snapshot} onRefreshGraph={graph.refresh} /></div>
      </div>
      {projectRead.error !== null && <section className="snapshot-error" role="alert">
        <p>{locale === "zh-CN" ? "无法读取项目信息。" : "Could not read project information."}</p>
        <button className="button" type="button" onClick={projectRead.retry}>{projects.retry}</button>
      </section>}
      <div className="project-layout">
        <ProjectSectionTabs section={section} onChange={selectSection} />
        <div className="project-section-content">
          {sectionIssue !== null && <p className="snapshot-notice" role="status">{preferences.section[sectionIssue.kind]}</p>}
          {tabIssue !== null && <p className="snapshot-notice" role="status">{preferences.tab[tabIssue.kind]}</p>}
          {assigneeIssue !== null && <p className="snapshot-notice" role="status">{preferences.assignee[assigneeIssue.kind]}</p>}
          {scrollIssue !== null && <p className="snapshot-notice" role="status">{preferences.scroll[scrollIssue.kind]}</p>}
          {snapshot !== null && notice?.kind === "selected-task-removed" && <div className="snapshot-notice snapshot-notice-dismissible" role="status">
            <span className="snapshot-notice-message">{m.selectedTaskRemoved}</span>
            <button className="snapshot-notice-dismiss" type="button" aria-label={m.dismissNotice} title={m.dismissNotice}
              onClick={() => { setNotice(null); heading.current?.focus({ preventScroll: true }); }}><span aria-hidden="true">×</span></button>
          </div>}
          {snapshot !== null && notice?.kind === "overview-target-unavailable" && <p className="snapshot-notice" role="status">{overview.targetUnavailable}</p>}
          <section className="project-section-panel project-overview" id="project-section-panel-overview" role="tabpanel"
            aria-labelledby="project-section-tab-overview" hidden={section !== "overview"} inert={section !== "overview"} tabIndex={0}>
            {section === "overview" && graphState}
            {snapshot !== null && <ProjectOverview snapshot={snapshot} progress={progress} pagination={{ ...overviewPagination, onPageChange: selectOverviewPage }} onNavigate={onOverviewNavigate} onOpenTask={onOpenTask} />}
          </section>
          <section className="project-section-panel project-tasks" id="project-section-panel-tasks" role="tabpanel"
            aria-labelledby="project-section-tab-tasks" hidden={section !== "tasks"} inert={section !== "tasks"} tabIndex={0}>
            {section === "tasks" && graphState}
            <TaskSearchWorkspace projectId={projectId} search={search} inputRef={searchInput} onOpenTask={onOpenSearchTask} />
            <div hidden={searchActive} inert={searchActive}>
            {snapshot !== null && (tasksMounted || section === "tasks") && <ProjectTaskWorkspace snapshot={snapshot} sessionStore={graph.sessionStore} pausedTaskCount={pausedTaskCount} active={section === "tasks" && !searchActive}
              filter={<div className="task-list-filters"><TaskAssigneeFilter projectId={projectId} filter={assigneeFilter} onChange={changeAssigneeFilter} /><label className="task-status-filter">{m.statusFilter}<span className="task-status-select"><select value={statusFilter} onChange={(event) => changeStatusFilter(event.currentTarget.value as TaskStatus | "all")}><option value="all">{m.allStatuses}</option><option value="proposed">{m.statusOptions.proposed}</option><option value="todo">{m.statusOptions.todo}</option><option value="in_progress">{m.statusOptions.in_progress}</option><option value="done">{m.statusOptions.done}</option><option value="cancelled">{m.statusOptions.cancelled}</option></select><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m2 4 3 3 3-3" /></svg></span></label></div>} activeView={activeView} unfinishedStandaloneTaskCount={unfinishedStandaloneTaskCount}
              unfinishedChainTaskCount={unfinishedChainTaskCount} goalCount={assignedGoals.length} onViewChange={selectView}
              chains={{ projectId, representativeIds: pageRootIds, allRepresentativeIds: scopedChainIds, scopedMembers, summaries: snapshot.summaries, revealTaskId, onRevealed: () => setRevealTaskId(null), onGraphRootChange: setChainOverlay, openGraphTarget, onOpenChain: (id, trigger) => onOpenListChain(id, trigger, null), onCloseChain, onRestoreGraphFocus: restoreGraphFocus, onNavigateExternalTask: onNavigateExternalChain,
                onOpenTask: (id, trigger) => trigger.closest(".task-chain-dialog") !== null ? onOpenChainTask(id, trigger) : onOpenListTask(id, trigger, null), onOpenSession,
                pagination: { ...chainPagination, onPageChange: selectChainPage } }}
              standalone={{ projectId, summaries: snapshot.summaries, taskIds: pageStandaloneIds, allTaskIds: scopedStandaloneIds, onSelectTask: (id, trigger) => onOpenListTask(id, trigger, null),
                pagination: { ...standalonePagination, onPageChange: selectStandalonePage } }}
              goals={{ projectId, goals: pageGoals, total: allGoals.length, onOpenGoal: onOpenTask, onOpenGoalGraph, onOpenGoalGraphTask: onOpenTask, graphError: graph.error, onRefreshGraph: graph.refresh, pagination: goalPagination,
                summaries: snapshot.summaries, openGraphTarget, onCloseChain, onRestoreGraphFocus: restoreGraphFocus, onNavigateExternalTask: onNavigateExternalChain,
                onOpenTask: onOpenChainTask, onOpenListTask, onOpenListChain, onGraphRootChange: setChainOverlay, onOpenSession }} />}
            </div>
          </section>
          <section className="project-section-panel project-prs" id="project-section-panel-prs" role="tabpanel"
            aria-labelledby="project-section-tab-prs" hidden={section !== "prs"} inert={section !== "prs"} tabIndex={0}>
            <PullRequestWorkspace userId={viewer.userId} projectId={projectId}
              canRead={projectRead.project !== null && !viewer.isInvalidated}
              active={section === "prs" && !history.error}
              onPrincipalMismatch={viewer.principalMismatch}
              onAccessError={() => { void projectAccess.session.revalidate(); }} />
          </section>
          <section className="project-section-panel" id="project-section-panel-tags" role="tabpanel"
            aria-labelledby="project-section-tab-tags" hidden={section !== "tags"} inert={section !== "tags"} tabIndex={0}>
            {(tagsMounted || section === "tags") && <ProjectTags projectId={projectId} active={section === "tags"} />}
          </section>
        </div>
      </div>
      <OverlayOwnerContext value={detailOwner}>{detailDialog}</OverlayOwnerContext>
      </div>
    </TaskExecutionClockProvider>
  );
};

export const ProjectPage = ({ projectId, renderActions }: { readonly projectId: string; readonly renderActions?: (project: Project) => ReactNode }) => <ProjectAccessBoundary projectId={projectId}><TaskDetailSessionBoundary><ProjectView key={projectId} projectId={projectId} {...(renderActions === undefined ? {} : { renderActions })} /></TaskDetailSessionBoundary></ProjectAccessBoundary>;
