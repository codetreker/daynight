import { ProjectStatistics } from "../project-statistics/ProjectStatistics";
import { isTerminalStatus } from "../../api/task-status";
import { ProjectAccessBoundary, useProjectAccess } from "./ProjectAccess";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import type { ExecutionPlatform, GraphTask, Project, TaskStatus } from "../../api/types";
import { navigate, parseGoalGraphUrl, parseTaskChainUrl } from "../../app/router";
import { browserNavigation } from "../../app/navigation";
import { useBrowserLocation } from "../../app/browser-location";
import { useProjectHistory } from "../../app/use-page-history";
import { ProjectDraftHost } from "../task-detail/TaskDraftNavigation";
import { OverlayOwnerContext } from "../../app/overlay";
import { canonicalId } from "../../api/validation";
import { ApiError, isAbortError } from "../../api/client";
import { resolveProjectTags } from "../../api/task-tags";
import { useI18n } from "../../i18n/LocaleProvider";
import { TaskDetailSessionBoundary, useTaskDetailSessions } from "../task-detail/TaskDetailSession";
import { TaskDetailDialog } from "../task-detail/TaskDetailDialog";
import { TaskExecutionClockProvider } from "../task-execution/TaskExecutionClock";
import { TaskOrganization } from "../task-detail/TaskOrganization";
import { GoalCreate } from "../goal-detail/GoalCreate";
import { projectTaskScope } from "../task-graph/scope";
import { ProjectOverview } from "./ProjectOverview";
import type { OverviewTaskTarget } from "./overview-progress";
import { useOverviewProgress } from "./useOverviewProgress";
import { taskPageSize, usePagination } from "./usePagination";
import { ProjectSectionTabs } from "./ProjectSectionTabs";
import { ProjectTaskWorkspace } from "./ProjectTaskWorkspace";
import { focusProjectList, focusVisible, type ProjectListOrigin } from "./project-list-focus";
import { resolveProjectGraphTarget, type ProjectGraphTarget } from "./project-graph-target";
import { useProjectAssigneeFilter, useProjectStatusFilter, useProjectSection, useTaskView, useProjectScroll, type ProjectSection, type TaskView } from "./useProjectViewPreferences";
import { ProjectGraphErrorDetail, projectGraphErrorTitle } from "./ProjectGraphError";
import { useTaskGraph, type GraphSnapshot } from "./useTaskGraph";
import { useProjectPageRead } from "./useProjectPageRead";
import { compareTaskStatus } from "./task-order";
import { ALL_TASK_STATUSES, matchesTaskStatus } from "./task-status-filter";
import { TaskStatusFilter } from "./TaskStatusFilter";
import { useTaskCacheScope } from "../task-cache/TaskCacheProvider";
import { useProjectAssigneeReceipt } from "../task-assignees/TaskAssignees";
import { TaskAssigneeFilter, matchesAssignee, type AssigneeFilter } from "../task-assignment/TaskAssigneeFilter";
import { pausedSummaryTaskIds } from "../task-pause/paused-summary";
import { TaskSearchWorkspace, assigneeValue } from "../task-search/TaskSearchWorkspace";
import { useTaskSearch } from "../task-search/useTaskSearch";
import { ProjectTags } from "../task-tags/ProjectTags";
import { TagFilter, useTagFilter, matchesTagFilter, type TagFilterValue } from "../task-tags/TagFilter";
import { PullRequestWorkspace } from "../pull-requests/PullRequestWorkspace";
import { usePullRequestRepositories } from "../pull-requests/usePullRequestRepositories";
import { NativeSelect } from "../../ui/native-select/NativeSelect";
import { ValueCopyButton, type CopyState } from "../../ui/copy-button/ValueCopyButton";
import "../../styles/project.css";

const RepositoryCopyFeedback = ({ state, event, success, failure }: {
  readonly state: CopyState; readonly event: string; readonly success: string; readonly failure: string;
}) => {
  const [expired, setExpired] = useState<string | null>(null);
  useEffect(() => {
    if (state !== "copied") return;
    const timer = window.setTimeout(() => setExpired(event), 3000);
    return () => window.clearTimeout(timer);
  }, [state, event]);
  const visible = state === "copied" && expired !== event;
  return <>
    <span className="project-repository-success" role={visible ? "status" : undefined} aria-hidden={!visible}>{success}</span>
    {state === "failed" && <span className="project-repository-error" role="alert">{failure}</span>}
  </>;
};

const backToProjects = (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate("/projects");
};

const emptyIds: readonly string[] = [];
type PlatformFilter = "all" | "any" | ExecutionPlatform;
const matchesPlatform = (task: GraphTask, filter: PlatformFilter) =>
  filter === "all" || (filter === "any" ? task.requiredPlatform === null : task.requiredPlatform === filter);

const matchesTaskTags = (snapshot: GraphSnapshot, task: GraphTask, filter: TagFilterValue) => {
  const summary = snapshot.summaries.get(task.id);
  return summary === undefined ? filter.tagIds.length === 0 && !filter.untagged : matchesTagFilter(summary.tags, filter);
};

type ProjectNotice = { readonly kind: "selected-task-removed" | "overview-target-unavailable" | "overview-tag-check-failed" };

const visibleTaskFilters = (tasks: readonly GraphTask[], assignee: AssigneeFilter, status: readonly TaskStatus[], userId: string, every: boolean) => {
  const assigneeMatches = (task: GraphTask) => matchesAssignee(task.assignedTo, assignee, userId);
  const statusMatches = (task: GraphTask) => matchesTaskStatus(status, task.status);
  if (every) return {
    assignee: tasks.every(assigneeMatches) ? assignee : { kind: "all" } as const,
    status: tasks.every(statusMatches) ? status : ALL_TASK_STATUSES,
  };
  if (tasks.some((task) => assigneeMatches(task) && statusMatches(task))) return { assignee, status };
  if (tasks.some(assigneeMatches)) return { assignee, status: ALL_TASK_STATUSES };
  if (tasks.some(statusMatches)) return { assignee: { kind: "all" } as const, status };
  return { assignee: { kind: "all" } as const, status: ALL_TASK_STATUSES };
};

const ProjectView = ({ projectId, renderActions }: { readonly projectId: string; readonly renderActions?: (project: Project) => ReactNode }) => {
  const graph = useTaskGraph(projectId);
  const projectRead = useProjectPageRead(projectId);
  const projectAccess = useProjectAccess(projectId);
  const graphOwner = useRef(Symbol());
  useProjectAssigneeReceipt(projectId, graphOwner.current, graph.snapshot?.revision ?? 0);
  const viewer = useTaskCacheScope();
  const { filter: assigneeFilter, onFilterChange: setAssigneeFilter, issue: assigneeIssue } = useProjectAssigneeFilter(projectId, viewer.userId);
  const { filter: statusFilter, onFilterChange: setStatusFilter, issue: statusIssue } = useProjectStatusFilter(projectId, viewer.userId);
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const sessions = useTaskDetailSessions();
  useEffect(() => sessions.subscribeProject(projectId, graph.reconcile), [sessions, projectId, graph.reconcile]);
  const { locale, messages: { workspace: { project: m, projects, app, preferences, overview }, auth: { shell: auth } }, format } = useI18n();
  const { section: preferredSection, onSectionChange, issue: sectionIssue } = useProjectSection(projectId);
  const { activeView: preferredView, onViewChange, issue: tabIssue } = useTaskView(projectId);
  const displayedGoal = useRef<string | null>(null);
  const isDisplayedGoal = useCallback((witness: string) => displayedGoal.current === witness, []);
  const location = useBrowserLocation();
  const navigation = browserNavigation();
  const navigationBusy = useSyncExternalStore(navigation.subscribeDecision, navigation.isBusy);
  const history = useProjectHistory(viewer.userId, projectId, true, { section: preferredSection, view: preferredView }, viewer, isDisplayedGoal);
  const historyRef = useRef(history);
  historyRef.current = history;
  const selection = history.selection;
  const { section, view: activeView, projectGraphWitness: graphWitness, detail: detailSelection } = selection;
  const prSources = usePullRequestRepositories({ userId: viewer.userId, projectId,
    active: (section === "prs" || section === "statistics") && !history.error,
    canRead: projectRead.project !== null && !viewer.isInvalidated,
    onPrincipalMismatch: viewer.principalMismatch, onAccessError: () => { void projectAccess.session.revalidate(); } });
  const [tasksMounted, setTasksMounted] = useState(false);
  const [tagsMounted, setTagsMounted] = useState(false);
  const [statisticsMounted, setStatisticsMounted] = useState(false);
  const [statisticsRefresh, setStatisticsRefresh] = useState(0);
  const [creatingGoal, setCreatingGoal] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const search = useTaskSearch(projectId, viewer, assigneeValue(assigneeFilter));
  const tagFilter = useTagFilter(projectId, section === "tasks");
  const childTagFilter = useTagFilter(projectId, section === "tasks" && activeView === "goals" && search.applied === null);
  const overviewTagCheck = useRef<AbortController | null>(null);
  useEffect(() => () => overviewTagCheck.current?.abort(), []);
  useLayoutEffect(() => viewer.subscribe(event => {
    if (event.projectId === projectId && (event.directAccessUncertain || event.accessRevoked || event.historyChanged || event.cacheGenerationChanged)) overviewTagCheck.current?.abort();
  }), [viewer, projectId]);
  const invalidReceipt = useRef({ projectId, viewer, revision: 0 });
  if (invalidReceipt.current.projectId !== projectId || invalidReceipt.current.viewer !== viewer) invalidReceipt.current = { projectId, viewer, revision: 0 };
  useLayoutEffect(() => {
    search.setFilters({ ...search.filters, type: activeView === "goals" ? "goal" : "task", parentId: null, ...tagFilter.value }, tagFilter.invalid);
  }, [activeView, tagFilter.value, tagFilter.invalid, search.setFilters]);
  useEffect(() => {
    if (invalidReceipt.current.revision === search.serverInvalidRevision) return;
    invalidReceipt.current.revision = search.serverInvalidRevision;
    if (search.filters.tagIds.length === tagFilter.value.tagIds.length && search.filters.tagIds.every((id, i) => id === tagFilter.value.tagIds[i])) tagFilter.markInvalid();
  }, [search.serverInvalidRevision, search.filters.tagIds, tagFilter.value.tagIds, tagFilter.markInvalid]);
  const searchActive = search.applied !== null;
  const [notice, setNotice] = useState<ProjectNotice | null>(null);
  const [pageNavigation, setPageNavigation] = useState<"overview" | TaskView | null>(null);
  const [navigationWitness, setNavigationWitness] = useState<string | null>(null);
  const [revealTaskId, setRevealTaskId] = useState<string | null>(null);
  const [listTarget, setListTarget] = useState<OverviewTaskTarget | null>(null);
  const highlightedTarget = useRef<{ readonly element: HTMLElement; readonly timer: ReturnType<typeof setTimeout> } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const originalTrigger = useRef<HTMLElement | null>(null);
  const pausedOrigin = useRef<HTMLElement | null>(null);
  const listOrigin = useRef<ProjectListOrigin | null>(null);
  const lastGraphResource = useRef<string | null>(null);
  const restoreRequested = useRef(false);
  const previousDetail = useRef(detailSelection);
  const closedDetail = useRef(detailSelection);
  const currentSelection = useRef(selection);
  currentSelection.current = selection;
  const currentLocation = useRef(location);
  currentLocation.current = location;
  const retireGraphReaders = (reading: typeof selection) => {
    if (reading.detail?.insideProjectGraph !== true) return;
    navigation.retireScope({ identity: viewer, projectId, taskId: reading.detail.id });
    const child = reading.detail.goalChildren?.task?.id;
    if (child !== undefined) navigation.retireScope({ identity: viewer, projectId, taskId: child });
  };
  const retireGraphReadersRef = useRef(retireGraphReaders);
  retireGraphReadersRef.current = retireGraphReaders;
  const currentGraphSnapshot = useRef(graph.snapshot);
  currentGraphSnapshot.current = graph.snapshot;
  const retiredReading = useRef<{ summaryId: string | null; snapshot: GraphSnapshot | null; entryId: string | null; section: ProjectSection; view: TaskView; goalWitness: string | null; waitForFocus: boolean } | null>(null);
  useLayoutEffect(() => viewer.subscribe((event) => {
    if (event.projectId !== projectId) return;
    if (event.accessRevoked) {
      retiredReading.current = null;
      const current = currentLocation.current;
      if (parseGoalGraphUrl(current.pathname, current.search).kind !== "none") {
        retireGraphReadersRef.current(currentSelection.current);
        // Retiring a draft may admit an already-arrived history destination.
        if (navigation.snapshot() === current)
          historyRef.current.select({ ...currentSelection.current, projectGraphWitness: null, detail: null }, true, undefined, "goal-invalid");
      }
      return;
    }
    const reading = currentSelection.current;
    if (!event.historyChanged || (reading.detail === null && reading.projectGraphWitness === null)) return;
    const current = currentLocation.current;
    if (navigation.snapshot() !== current) { retiredReading.current = null; return; }
    if (parseGoalGraphUrl(current.pathname, current.search).kind === "goal") retireGraphReadersRef.current(reading);
    if (navigation.snapshot() !== current) { retiredReading.current = null; return; }
    const goalWitness = reading.projectGraphWitness !== null && displayedGoal.current === reading.projectGraphWitness ? reading.projectGraphWitness : null;
    retiredReading.current = { summaryId: reading.detail?.source === "summary" ? reading.detail.id : null,
      snapshot: currentGraphSnapshot.current, entryId: browserNavigation().snapshot().entryId, section: reading.section, view: reading.view,
      goalWitness, waitForFocus: goalWitness === null };
    if (goalWitness === null) { listOrigin.current = null; lastGraphResource.current = null; originalTrigger.current = null; pausedOrigin.current = null; }
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
  const snapshot = graph.displaySnapshot;
  const currentSnapshot = graph.snapshot;
  const overviewFence = useRef({ snapshot, assigneeFilter, statusFilter, platformFilter, value: tagFilter.value, invalid: tagFilter.invalid });
  overviewFence.current = { snapshot, assigneeFilter, statusFilter, platformFilter, value: tagFilter.value, invalid: tagFilter.invalid };
  useLayoutEffect(() => { overviewTagCheck.current?.abort(); }, [selection, snapshot, assigneeFilter, statusFilter, platformFilter, tagFilter.value, tagFilter.invalid]);
  const snapshotReady = snapshot !== null;
  const [panelReadiness, setPanelReadiness] = useState({ prs: false, tags: false, statistics: false });
  const setPRScrollReady = useCallback((ready: boolean) => setPanelReadiness(previous => previous.prs === ready ? previous : { ...previous, prs: ready }), []);
  const setTagScrollReady = useCallback((ready: boolean) => setPanelReadiness(previous => previous.tags === ready ? previous : { ...previous, tags: ready }), []);
  const setStatisticsScrollReady = useCallback((ready: boolean) => setPanelReadiness(previous => previous.statistics === ready ? previous : { ...previous, statistics: ready }), []);
  const projectReady = projectRead.project !== null && projectRead.error === null && !viewer.isInvalidated && !viewer.isProjectSuspended(projectId) && !history.error;
  const sectionReady = section === "overview" || section === "tasks"
    ? snapshotReady && currentSnapshot !== null && currentSnapshot.receivedAt !== null && graph.error === null && (section !== "tasks" || !searchActive || !search.busy && search.error === null && search.total !== null)
    : panelReadiness[section];
  const explicitTarget = location.hash !== "" || new URLSearchParams(location.search).has("chain") || new URLSearchParams(location.search).has("goalGraph");
  const { savePosition, cancelRestore, issue: scrollIssue } = useProjectScroll(projectId, viewer.userId, section, projectReady && sectionReady, explicitTarget, activeView);
  useLayoutEffect(() => {
    if (!snapshotReady) setTasksMounted(false);
    else if (section === "tasks") setTasksMounted(true);
  }, [snapshotReady, section]);
  useLayoutEffect(() => { if (section === "tags") setTagsMounted(true); if (section === "statistics") setStatisticsMounted(true); }, [section]);
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
  const unfinishedGoalCount = assignedGoals.filter((goal) => !isTerminalStatus(goal.status)).length;
  const goals = assignedGoals.filter((goal) =>
    matchesTaskStatus(statusFilter, goal.status) && !tagFilter.invalid && matchesTagFilter(goal.tags, tagFilter.value));
  const pausedTasks = useMemo(() => {
    if (snapshot === null) return [];
    const ids = pausedSummaryTaskIds(snapshot.graph.tasks, snapshot.pausedTaskIds);
    return snapshot.graph.tasks.filter((task) => ids.has(task.id) && matchesAssignee(task.assignedTo, assigneeFilter, viewer.userId));
  },
  [snapshot, assigneeFilter, viewer.userId]);
  const matchingTaskIds = useMemo(() => snapshot === null ? new Set<string>()
    : new Set([...snapshot.index.nodes.values()].filter((task) => matchesAssignee(task.assignedTo, assigneeFilter, viewer.userId) &&
      matchesTaskStatus(statusFilter, task.status) && !tagFilter.invalid &&
      matchesTaskTags(snapshot, task, tagFilter.value) && matchesPlatform(task, platformFilter)).map((task) => task.id)), [snapshot, assigneeFilter, statusFilter, viewer.userId, tagFilter.value, tagFilter.invalid, platformFilter]);
  const scopedChainIds = (categories?.chains ?? emptyIds).filter((id) => scopedMembers.has(id));
  const scopedStandaloneIds = (categories?.standalone ?? emptyIds).filter((id) => scope?.standaloneIds.includes(id));
  const unfinishedMatches = (id: string) => {
    const task = snapshot!.index.nodes.get(id)!;
    return !isTerminalStatus(task.status) && matchesCurrentAssignee(task.assignedTo);
  };
  const unfinishedStandaloneTaskCount = scopedStandaloneIds.filter(unfinishedMatches).length;
  const unfinishedChainCount = [...scopedMembers.values()].filter((memberIds) => memberIds.some(unfinishedMatches)).length;
  const rootIds = scopedChainIds.filter((id) => scopedMembers.get(id)!.some((member) => matchingTaskIds.has(member)));
  const standaloneIds = scopedStandaloneIds.filter((id) => matchingTaskIds.has(id));
  const chainPagination = usePagination(rootIds.length);
  const standalonePagination = usePagination(standaloneIds.length);
  const goalPagination = usePagination(goals.length);
  const skipTagPageReset = useRef(false);
  const resetTaskPages = useRef(() => {});
  resetTaskPages.current = () => { chainPagination.onPageChange(1); standalonePagination.onPageChange(1); goalPagination.onPageChange(1); };
  useEffect(() => {
    if (skipTagPageReset.current) { skipTagPageReset.current = false; return; }
    resetTaskPages.current();
  }, [tagFilter.value, tagFilter.invalid]);
  const overviewPagination = usePagination(progress.chains.length + (progress.standalone === null ? 0 : 1), 20);
  useLayoutEffect(() => { overviewTagCheck.current?.abort(); }, [overviewPagination.page]);
  const pageRootIds = rootIds.slice(chainPagination.start - 1, chainPagination.end);
  const pageStandaloneIds = standaloneIds.slice(standalonePagination.start - 1, standalonePagination.end);
  const pageGoals = goals.slice(goalPagination.start - 1, goalPagination.end);
  const selectChainPage = (page: number) => { cancelRestore(); chainPagination.onPageChange(page); setPageNavigation("chains"); };
  const selectStandalonePage = (page: number) => { cancelRestore(); standalonePagination.onPageChange(page); setPageNavigation("standalone"); };
  const changeAssigneeFilter = (filter: AssigneeFilter) => { chainPagination.onPageChange(1); standalonePagination.onPageChange(1); goalPagination.onPageChange(1); setAssigneeFilter(filter); };
  const changeStatusFilter = (filter: readonly TaskStatus[]) => { chainPagination.onPageChange(1); standalonePagination.onPageChange(1); goalPagination.onPageChange(1); setStatusFilter(filter); };
  const changePlatformFilter = (filter: PlatformFilter) => { chainPagination.onPageChange(1); standalonePagination.onPageChange(1); setPlatformFilter(filter); };
  const selectOverviewPage = (page: number) => { cancelRestore(); overviewPagination.onPageChange(page); setPageNavigation("overview"); };
  useLayoutEffect(() => {
    if (pageNavigation === null) return;
    const id = pageNavigation === "overview" ? "project-overview-progress" : pageNavigation === "chains" ? "project-chain-list" : "project-standalone-list";
    const target = document.getElementById(id);
    if (target !== null && target.closest('[hidden], [inert]') === null) {
      cancelRestore();
      target.scrollIntoView({ block: "start", behavior: "instant" });
      target.focus({ preventScroll: true });
      savePosition();
    }
    setPageNavigation(null);
  }, [pageNavigation, chainPagination.page, standalonePagination.page, overviewPagination.page, savePosition, cancelRestore]);
  if (graphWitness !== null) lastGraphResource.current = graphWitness;
  const openGraphTarget = section === "tasks" && (activeView === "chains" || activeView === "goals")
    ? resolveProjectGraphTarget(graphWitness, snapshot?.index ?? null, activeView === "goals" ? snapshot?.summaries : undefined) : null;
  openGraph.current = openGraphTarget;
  useLayoutEffect(() => {
    displayedGoal.current = openGraphTarget?.kind === "goal" && chainOverlay?.isConnected ? graphWitness : null;
    return () => { displayedGoal.current = null; };
  }, [openGraphTarget, chainOverlay, graphWitness]);
  useLayoutEffect(() => {
    if (graphWitness === null || currentSnapshot === null || currentSnapshot.receivedAt === null) return;
    const goalUrl = parseGoalGraphUrl(location.pathname, location.search);
    const lostLinkedGoal = goalUrl.kind === "goal" && goalUrl.goalId === graphWitness && currentSnapshot.summaries.get(graphWitness)?.type !== "goal";
    if (!lostLinkedGoal && openGraphTarget !== null) return;
    if (navigation.snapshot() !== location) return;
    if (lostLinkedGoal) retireGraphReaders(selection);
    if (navigation.snapshot() !== location) return;
    history.select({ ...selection, projectGraphWitness: null, ...(lostLinkedGoal ? { detail: null } : {}) }, true);
    if (section !== "tasks") focusVisible(document.getElementById(`project-section-tab-${section}`));
    else if (activeView !== "chains" && activeView !== "goals") focusVisible(document.getElementById(`project-task-tab-${activeView}`));
  }, [graphWitness, openGraphTarget, section, activeView, currentSnapshot, selection, history.select, location]);
  const onOpenListChain = useCallback((id: string, trigger: HTMLElement, sourceGoalId: string | null) => {
    history.select({ ...selection, projectGraphWitness: id }, false, () => {
      listOrigin.current = { view: activeView, sourceGoalId, resourceWitness: id, trigger }; pausedOrigin.current = null;
      restoreRequested.current = false; originalTrigger.current = null; searchTrigger.current = false;
    });
  }, [activeView, history.select, selection]);
  const onOpenGoalGraph = useCallback((id: string, trigger: HTMLElement) => onOpenListChain(id, trigger, id), [onOpenListChain]);
  const onCloseChain = useCallback(() => { history.select({ ...selection, projectGraphWitness: null, detail: selection.detail?.insideProjectGraph ? null : selection.detail }, true); }, [history.select, selection]);

  const selectedSummary = useRef<{ id: string; revision: number } | null>(null);
  if (detailSelection === null || detailSelection.source !== "summary") selectedSummary.current = null;
  else if (currentSnapshot !== null && selectedSummary.current?.id !== detailSelection.id) selectedSummary.current = { id: detailSelection.id, revision: currentSnapshot.revision };
  useEffect(() => {
    if (currentSnapshot === null || detailSelection === null || detailSelection.source !== "summary" || selectedSummary.current?.revision === currentSnapshot.revision || currentSnapshot.summaries.has(detailSelection.id)) return;
    history.select({ ...selection, detail: null }, true, () => {
      restoreRequested.current = true;
      setNotice({ kind: "selected-task-removed" });
    });
  }, [currentSnapshot, detailSelection, selection, history.select]);

  const onOpenTask = useCallback((id: string, trigger: HTMLElement) => {
    history.select({ ...selection, detail: { id, source: "summary", insideProjectGraph: trigger.closest(".task-chain-dialog") !== null,
      navigation: { tab: "overview", path: null }, goalChildren: null } }, false, () => {
      restoreRequested.current = false; pausedOrigin.current = null; originalTrigger.current = trigger; searchTrigger.current = false; setNotice(null);
    });
  }, [history.select, selection]);
  const onOpenListTask = useCallback((id: string, trigger: HTMLElement, sourceGoalId: string | null) => {
    history.select({ ...selection, detail: { id, source: "summary", insideProjectGraph: false,
      navigation: { tab: "overview", path: null }, goalChildren: null } }, false, () => {
      listOrigin.current = { view: activeView, sourceGoalId, resourceWitness: id, trigger }; pausedOrigin.current = null;
      restoreRequested.current = false; originalTrigger.current = null; searchTrigger.current = false; setNotice(null);
    });
  }, [activeView, history.select, selection]);
  const onOpenSearchTask = useCallback((id: string, trigger: HTMLElement) => {
    history.select({ ...selection, detail: { id, source: "direct", insideProjectGraph: false,
      navigation: { tab: "overview", path: null }, goalChildren: null } }, false, () => {
      restoreRequested.current = false; listOrigin.current = null; pausedOrigin.current = null; originalTrigger.current = trigger; searchTrigger.current = true; setNotice(null);
    });
  }, [history.select, selection]);
  const onOpenPausedTask = useCallback((id: string, trigger: HTMLElement) => {
    history.select({ ...selection, detail: { id, source: "summary", insideProjectGraph: false,
      navigation: { tab: "overview", path: null }, goalChildren: null } }, false, () => {
      restoreRequested.current = false; listOrigin.current = null; pausedOrigin.current = trigger; originalTrigger.current = trigger; searchTrigger.current = false; setNotice(null);
    });
  }, [history.select, selection]);
  const onPausedFocusFallback = useCallback(() => {
    if (!focusVisible(document.getElementById(`project-task-tab-${currentView.current}`)) &&
      !focusVisible(document.getElementById("project-section-tab-tasks"))) focusVisible(heading.current);
  }, []);
  const onOpenSession = useCallback((id: string, trigger: HTMLElement) => {
    const insideProjectGraph = trigger.closest(".task-chain-dialog") !== null;
    history.select({ ...selection, detail: { id, source: "summary", insideProjectGraph,
      navigation: { tab: "session", path: null }, goalChildren: null } }, false, () => {
      listOrigin.current = insideProjectGraph ? null : { view: activeView, sourceGoalId: trigger.closest<HTMLElement>("[data-goal-id]")?.dataset.goalId ?? null, resourceWitness: id, trigger };
      restoreRequested.current = false; pausedOrigin.current = null; originalTrigger.current = insideProjectGraph ? trigger : null; searchTrigger.current = false; setNotice(null);
    });
  }, [activeView, history.select, selection]);
  const onSelectRelation = useCallback((id: string) => {
    history.select({ ...selection, detail: { id, source: detailSelection?.source === "direct" || currentSnapshot === null ? "direct" : "summary",
      insideProjectGraph: detailSelection?.insideProjectGraph ?? false, navigation: { tab: "overview", path: null }, goalChildren: null } }, false);
  }, [history.select, selection, detailSelection, currentSnapshot]);
  const onClose = useCallback(() => { history.select({ ...selection, detail: null }, true, () => { restoreRequested.current = true; }); }, [history.select, selection]);
  const projectMounted = useRef(true);
  useLayoutEffect(() => { projectMounted.current = true; return () => { projectMounted.current = false; }; }, []);
  const indexForFocus = useRef(snapshot?.index ?? null);
  indexForFocus.current = snapshot?.index ?? null;
  const summariesForFocus = useRef(snapshot?.summaries);
  summariesForFocus.current = snapshot?.summaries;
  const restoreFocus = useCallback(() => {
    if (!restoreRequested.current || previousDetail.current !== null || retiredReading.current?.waitForFocus) return;
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
      if (pausedOrigin.current !== null) {
        if (focusVisible(pausedOrigin.current)) return true;
        if (focusVisible(document.getElementById(`project-task-tab-${currentView.current}`))) return true;
        if (focusVisible(document.getElementById("project-section-tab-tasks"))) return true;
        return focusVisible(heading.current);
      }
      if (origin === null && focusVisible(trigger)) return true;
      const detailWitness = !fromSearch && closedDetail.current?.source === "summary" && !closedDetail.current.insideProjectGraph ? closedDetail.current.id : null;
      if (focusProjectList(currentView.current, origin, resolveProjectGraphTarget(lastGraphResource.current, indexForFocus.current, summariesForFocus.current), indexForFocus.current, lastGraphResource.current, detailWitness)) return true;
      if (focusVisible(document.getElementById(`project-task-tab-${currentView.current}`))) return true;
      if (focusVisible(document.getElementById(`project-section-tab-${currentSection.current}`))) return true;
      return focusVisible(heading.current);
    };
    const finish = () => {
      if (!restoreRequested.current || retiredReading.current?.waitForFocus || !focus()) return;
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
    const retired = retiredReading.current;
    if (retired === null) return;
    if (browserNavigation().snapshot().entryId !== retired.entryId || section !== retired.section || activeView !== retired.view ||
      detailSelection !== null || graphWitness !== retired.goalWitness) {
      retiredReading.current = null;
      if (retired.waitForFocus) restoreRequested.current = false;
      return;
    }
    if (currentSnapshot === null || currentSnapshot === retired.snapshot || currentSnapshot.receivedAt === null) return;
    retiredReading.current = null;
    if (retired.summaryId !== null && !currentSnapshot.summaries.has(retired.summaryId)) setNotice({ kind: "selected-task-removed" });
    if (retired.waitForFocus && document.activeElement === document.body) restoreFocus();
  }, [currentSnapshot, section, activeView, detailSelection, graphWitness, restoreFocus]);

  const selectView = useCallback((view: TaskView) => {
    if (view === activeView) return;
    history.select({ ...selection, view, projectGraphWitness: null }, false, () => onViewChange(view));
  }, [activeView, history.select, selection, onViewChange]);

  const selectSection = useCallback((next: ProjectSection, onCommit?: () => void) => {
    if (next === section) return;
    history.select({ ...selection, section: next, projectGraphWitness: null }, false, () => {
      cancelRestore();
      if (next !== "statistics") onSectionChange(next);
      onCommit?.();
    });
  }, [section, cancelRestore, onSectionChange, history.select, selection]);

  const clearTargetHighlight = useCallback(() => {
    if (highlightedTarget.current === null) return;
    clearTimeout(highlightedTarget.current.timer);
    highlightedTarget.current.element.classList.remove("overview-progress-target");
    highlightedTarget.current = null;
  }, []);
  useEffect(() => clearTargetHighlight, [clearTargetHighlight]);


  const onNavigateExternalTask = useCallback((id: string, trigger: HTMLElement, fromFragment: boolean | 'chain' = false) => {
    const select: typeof history.select = (next, replace, onCommit) => history.select(next, replace, onCommit, fromFragment);
    const task = snapshot?.index.nodes.get(id);
    if (snapshot === null || task === undefined) { setNotice({ kind: "overview-target-unavailable" }); return; }
    if (detailSelection === null) pausedOrigin.current = null;
    if (task.parentId === null && detailSelection === null && (activeView === "chains" || activeView === "goals") && openGraphTarget !== null) {
      const representative = snapshot.index.componentByTask.get(id)!;
      if (snapshot.index.components.get(representative)!.memberIds.size === 1) {
        select({ ...selection, projectGraphWitness: null, detail: { id, source: "summary", insideProjectGraph: false,
          navigation: { tab: "overview", path: null }, goalChildren: null } }, false, () => {
          restoreRequested.current = false; originalTrigger.current = null; searchTrigger.current = false; setNotice(null);
        });
      } else select({ ...selection, projectGraphWitness: id });
      return;
    }
    if (task.parentId !== null) {
      if (snapshot.summaries.get(task.parentId)?.type !== "goal") { if (fromFragment) select(selection, true); setNotice({ kind: "overview-target-unavailable" }); return; }
      const insideProjectGraph = detailSelection?.insideProjectGraph === true || openGraphTarget !== null && trigger.closest(".task-chain-dialog") !== null;
      const goalId = task.parentId;
      select({ ...selection, detail: { id: goalId, source: "summary", insideProjectGraph,
        navigation: { tab: "description", path: null }, goalChildren: { graphRootId: null, task: { id, navigation: { tab: "overview", path: null } } } } }, false, () => {
        if (originalTrigger.current === null) originalTrigger.current = trigger;
        setNotice(null);
      });
      return;
    }
    const representative = snapshot.index.componentByTask.get(id)!;
    const members = [...snapshot.index.components.get(representative)!.memberIds]
      .map((member) => snapshot.index.nodes.get(member)!).filter((member) => member.parentId === null);
    if (detailSelection !== null && (tagFilter.invalid || !members.some((member) => matchesTaskTags(snapshot, member, tagFilter.value)))) {
      select({ ...selection, detail: { id, source: "summary", insideProjectGraph: detailSelection.insideProjectGraph && openGraphTarget !== null,
        navigation: { tab: "overview", path: null }, goalChildren: null } }, false, () => {
        if (originalTrigger.current === null) originalTrigger.current = trigger;
        setNotice(null);
      });
      return;
    }
    const view = snapshot.index.components.get(representative)!.memberIds.size === 1 ? "standalone" : "chains";
    const commit = () => {
      cancelRestore();
      if (detailSelection !== null) suppressRestore.current = true;
      if (originalTrigger.current === null) originalTrigger.current = trigger;
      if (search.applied !== null) search.clear();
      setNotice(null); setAssigneeFilter({ kind: "all" }); setStatusFilter(ALL_TASK_STATUSES);
      if (!tagFilter.invalid && members.some((member) => matchesTaskTags(snapshot, member, tagFilter.value)) &&
        !members.some((member) => matchesTaskTags(snapshot, member, tagFilter.value) && matchesPlatform(member, platformFilter))) {
        chainPagination.onPageChange(1); standalonePagination.onPageChange(1); setPlatformFilter("all");
      }
      if (section !== "tasks" && !fromFragment) onSectionChange("tasks");
      if (!fromFragment && view !== activeView) onViewChange(view);
      setNavigationWitness(id);
    };
    if (section === "tasks" && activeView === view && graphWitness === null && detailSelection === null && !fromFragment) commit();
    else select({ ...selection, section: "tasks", view, projectGraphWitness: null, detail: null }, false, commit);
  }, [snapshot, detailSelection, activeView, openGraphTarget, graphWitness, history.select, selection, search.applied, search.clear, setAssigneeFilter, setStatusFilter, tagFilter.value, tagFilter.invalid, platformFilter, chainPagination.onPageChange, standalonePagination.onPageChange, section, cancelRestore, onSectionChange, onViewChange]);

  const onNavigateExternalChain = useCallback((id: string, trigger: HTMLElement, fromFragment: boolean | 'chain' = false) => {
    const select: typeof history.select = (next, replace, onCommit) => history.select(next, replace, onCommit, fromFragment);
    const task = snapshot?.index.nodes.get(id);
    if (snapshot === null || task === undefined) { setNotice({ kind: "overview-target-unavailable" }); return; }
    if (detailSelection === null) pausedOrigin.current = null;
    const representative = snapshot.index.componentByTask.get(id)!;
    if (snapshot.index.components.get(representative)!.memberIds.size === 1) {
      if (task.parentId !== null) onNavigateExternalTask(id, trigger, fromFragment);
      else select({ ...selection, projectGraphWitness: null, detail: { id, source: "summary", insideProjectGraph: false,
        navigation: { tab: "overview", path: null }, goalChildren: null } }, false, () => {
        restoreRequested.current = false;
        if (originalTrigger.current === null) originalTrigger.current = trigger;
        searchTrigger.current = false; setNotice(null);
      });
      return;
    }
    if (task.parentId !== null) {
      if (snapshot.summaries.get(task.parentId)?.type !== "goal") { if (fromFragment) select(selection, true); setNotice({ kind: "overview-target-unavailable" }); return; }
      const insideProjectGraph = detailSelection?.insideProjectGraph === true || openGraphTarget !== null && trigger.closest(".task-chain-dialog") !== null;
      select({ ...selection, detail: { id: task.parentId, source: "summary", insideProjectGraph,
        navigation: { tab: "description", path: null }, goalChildren: { graphRootId: representative, task: null } } }, false, () => {
        if (originalTrigger.current === null) originalTrigger.current = trigger;
        setNotice(null);
      });
    } else {
      const view = activeView === "goals" ? "goals" : "chains";
      select({ ...selection, section: "tasks", view, projectGraphWitness: id, detail: null }, false, () => {
        if (detailSelection !== null) suppressRestore.current = true;
        if (originalTrigger.current === null) originalTrigger.current = trigger;
        setNotice(null);
        if (section !== "tasks") { cancelRestore(); if (!fromFragment) onSectionChange("tasks"); }
        if (!fromFragment && activeView !== view) onViewChange(view);
      });
    }
  }, [snapshot, onNavigateExternalTask, detailSelection, openGraphTarget, history.select, selection, activeView, section, cancelRestore, onSectionChange, onViewChange]);

  const onOpenChainTask = useCallback((id: string, trigger: HTMLElement) => {
    if (trigger.closest(".task-chain-dialog") !== null && snapshot?.index.nodes.get(id)?.parentId != null) onNavigateExternalTask(id, trigger);
    else onOpenTask(id, trigger);
  }, [snapshot, onNavigateExternalTask, onOpenTask]);

  const onOverviewNavigate = useCallback((target: OverviewTaskTarget) => {
    cancelRestore();
    overviewTagCheck.current?.abort();
    if (target.kind === "chain" && snapshot?.index.nodes.get(target.taskId)?.parentId != null) {
      onNavigateExternalTask(target.taskId, document.activeElement instanceof HTMLElement ? document.activeElement : heading.current!);
      return;
    }
    const view = target.kind === "chain" ? "chains" : "standalone";
    const ids = snapshot === null ? [] : target.kind === "standalone" ? progress.recentStandaloneIds
      : [...(snapshot.index.components.get(snapshot.index.componentByTask.get(target.taskId) ?? "")?.memberIds ?? [])];
    const tasks = snapshot === null ? [] : ids.map((id) => snapshot.index.nodes.get(id)!).filter((task) => task !== undefined && task.parentId === null);
    const filters = visibleTaskFilters(tasks, assigneeFilter, statusFilter, viewer.userId, target.kind === "standalone");
    const matches = (task: GraphTask) => snapshot !== null && matchesAssignee(task.assignedTo, filters.assignee, viewer.userId) &&
      matchesTaskStatus(filters.status, task.status) && matchesTaskTags(snapshot, task, tagFilter.value);
    const tagBlocks = snapshot !== null && tasks.length > 0 && !(target.kind === "standalone" ? tasks.every(matches) : tasks.some(matches));
    const navigateToTarget = (clearTags: boolean, blocked: boolean) => history.select({ ...selection, section: "tasks", view, projectGraphWitness: null }, false, () => {
      cancelRestore();
      if (search.applied !== null) search.clear();
      setNotice(null);
      if (snapshot !== null) {
        if (filters.assignee !== assigneeFilter || filters.status !== statusFilter) {
          chainPagination.onPageChange(1); standalonePagination.onPageChange(1); goalPagination.onPageChange(1);
          if (filters.assignee !== assigneeFilter) setAssigneeFilter(filters.assignee);
          setStatusFilter(filters.status);
        }
        if (clearTags) {
          skipTagPageReset.current = true;
          if (view === "chains") standalonePagination.onPageChange(1); else chainPagination.onPageChange(1);
          goalPagination.onPageChange(1);
          tagFilter.update({ ...tagFilter.value, tagIds: [], untagged: false });
        }
        const platformMatches = (task: GraphTask) => matchesAssignee(task.assignedTo, filters.assignee, viewer.userId) &&
          matchesTaskStatus(filters.status, task.status) && (clearTags || matchesTaskTags(snapshot, task, tagFilter.value)) && matchesPlatform(task, platformFilter);
        if (!blocked && tasks.length > 0 && !(target.kind === "standalone" ? tasks.every(platformMatches) : tasks.some(platformMatches))) {
          chainPagination.onPageChange(1); standalonePagination.onPageChange(1); setPlatformFilter("all");
        }
      }
      setListTarget(blocked ? null : target);
      if (view !== activeView) onViewChange(view);
      if (section !== "tasks") onSectionChange("tasks");
    });
    if (tagFilter.invalid) { navigateToTarget(false, true); return; }
    if (!tagBlocks || tagFilter.value.tagIds.length === 0) { navigateToTarget(tagBlocks, false); return; }
    const controller = new AbortController(); overviewTagCheck.current = controller;
    const signal = AbortSignal.any([controller.signal, viewer.signal]);
    void (async () => {
      let missing = false, verified = false;
      try {
        await viewer.ready(signal);
        if (viewer.isProjectSuspended(projectId)) return;
        await resolveProjectTags(projectId, tagFilter.value.tagIds, signal, { userId: viewer.userId, onPrincipalMismatch: viewer.principalMismatch });
        verified = true;
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        missing = error instanceof ApiError && error.code === "tag_not_found";
      }
      try { await viewer.ready(signal); } catch { return; }
      const current = overviewFence.current;
      if (signal.aborted || viewer.isInvalidated || viewer.isProjectSuspended(projectId) || currentSelection.current !== selection || current.snapshot !== snapshot ||
        current.assigneeFilter !== assigneeFilter || current.statusFilter !== statusFilter || current.platformFilter !== platformFilter || current.value !== tagFilter.value || current.invalid !== tagFilter.invalid) return;
      if (missing) tagFilter.markInvalid();
      if (!verified && !missing) { setNotice({ kind: "overview-tag-check-failed" }); return; }
      navigateToTarget(verified, missing);
    })();
  }, [history.select, selection, snapshot, progress.recentStandaloneIds, assigneeFilter, setAssigneeFilter, statusFilter, setStatusFilter, platformFilter, viewer, projectId, tagFilter.invalid, tagFilter.value, tagFilter.update, tagFilter.markInvalid, chainPagination.onPageChange, standalonePagination.onPageChange, goalPagination.onPageChange, search.applied, search.clear, onNavigateExternalTask, activeView, onViewChange, section, cancelRestore, onSectionChange]);

  const goalUrl = parseGoalGraphUrl(location.pathname, location.search);
  useEffect(() => {
    if (navigationBusy || goalUrl.kind === "none") return;
    if (goalUrl.kind === "invalid") {
      history.select({ ...selection, projectGraphWitness: null, detail: null }, true, () => setNotice({ kind: "overview-target-unavailable" }), "goal-invalid");
      return;
    }
    if (selection.section === "tasks" && selection.view === "goals" && selection.projectGraphWitness === goalUrl.goalId) return;
    // A cached preview can supply background content but cannot authorize a URL.
    if (currentSnapshot === null || currentSnapshot.receivedAt === null || snapshot !== currentSnapshot) return;
    if (currentSnapshot.summaries.get(goalUrl.goalId)?.type !== "goal") {
      history.select({ ...selection, projectGraphWitness: null, detail: null }, true, () => setNotice({ kind: "overview-target-unavailable" }), "goal-invalid");
      return;
    }
    history.select({ ...selection, section: "tasks", view: "goals", projectGraphWitness: goalUrl.goalId, detail: null }, true, () => {
      listOrigin.current = null; pausedOrigin.current = null; originalTrigger.current = null; searchTrigger.current = false; restoreRequested.current = false;
    }, "goal");
  }, [goalUrl.kind, goalUrl.kind === "goal" ? goalUrl.goalId : null, navigationBusy, currentSnapshot, snapshot, selection, history.select]);

  const attemptedFragment = useRef<typeof location | null>(null);
  useEffect(() => {
    if (goalUrl.kind !== "none") return;
    const query = parseTaskChainUrl(location.pathname, location.search);
    if (navigationBusy || snapshot === null || (query.kind === "none" && !location.hash.startsWith("#task=") && !location.hash.startsWith("#chain=")) || attemptedFragment.current === location) return;
    if (query.kind !== "none" && (currentSnapshot === null || currentSnapshot.receivedAt === null || snapshot.receivedAt === null)) return;
    attemptedFragment.current = location;
    if (query.kind !== "none") {
      if (query.kind === "invalid" || snapshot.index.nodes.get(query.taskId)?.type !== "task") {
        history.select(selection, true, () => setNotice({ kind: "overview-target-unavailable" }), 'chain');
      } else onNavigateExternalChain(query.taskId, heading.current!, 'chain');
      return;
    }
    const chain = location.hash.startsWith("#chain=");
    const value = new URLSearchParams(location.hash.slice(1)).get(chain ? "chain" : "task");
    const id = value === null ? null : canonicalId(value);
    if (id === null || !snapshot.index.nodes.has(id)) { browserNavigation().clearFragment(); setNotice({ kind: "overview-target-unavailable" }); return; }
    if (chain) onNavigateExternalChain(id, heading.current!, true);
    else onNavigateExternalTask(id, heading.current!, true);
  }, [snapshot, currentSnapshot, location, navigationBusy, onNavigateExternalTask, onNavigateExternalChain, history.select, selection, goalUrl.kind]);

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
      cancelRestore();
      target.scrollIntoView({ block: "center", behavior: "instant" });
      target.focus({ preventScroll: true });
    }
    setNavigationWitness(null);
  }, [navigationWitness, snapshot, section, activeView, rootIds, standaloneIds, chainPagination, standalonePagination, cancelRestore]);

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
    cancelRestore();
    target.scrollIntoView({ block: listTarget.kind === "chain" ? "center" : "start", behavior: "instant" });
    target.focus({ preventScroll: true });
    savePosition();
    target.classList.add("overview-progress-target");
    highlightedTarget.current = { element: target, timer: setTimeout(clearTargetHighlight, 2_200) };
  }, [listTarget, section, activeView, snapshot, rootIds, chainPagination, standalonePagination, savePosition, cancelRestore, clearTargetHighlight]);

  const detailInsideGraph = detailSelection?.source === "summary" && detailSelection.insideProjectGraph === true && openGraphTarget !== null;
  const detailOwner = useMemo(() => detailInsideGraph && chainOverlay !== null
    ? { current: chainOverlay } : null, [detailInsideGraph, chainOverlay]);
  const detailDialog = detailSelection === null ? null : <ProjectDraftHost projectId={projectId} taskId={detailSelection.id} source={detailSelection.source} summaryType={currentSnapshot === null ? undefined : currentSnapshot.summaries.get(detailSelection.id)?.type ?? null} insideProjectGraph={detailSelection.insideProjectGraph} graphWitness={selection.projectGraphWitness}><TaskDetailDialog projectId={projectId} taskId={detailSelection.id} snapshot={currentSnapshot} observation={detailSelection.source === "direct" ? { kind: "direct" } : { kind: "project-summary", revision: currentSnapshot?.revision ?? 0, task: currentSnapshot?.index.nodes.get(detailSelection.id) }} onSelectTask={onSelectRelation}
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
            {projectRead.project !== null && <div className="project-repository">
              <span className="project-repository-value">{projectRead.project.repoUrl}</span>
              <ValueCopyButton key={projectRead.project.id} value={projectRead.project.repoUrl} label={m.copyRepositoryUrl} className="project-repository-copy"
                feedback={(state, event) => <RepositoryCopyFeedback key={projectRead.project?.repoUrl} state={state} event={event} success={m.repositoryUrlCopied} failure={m.copyRepositoryUrlFailed} />} />
            </div>}
          </div>
        </div>
        <div className="project-title-actions">{projectRead.project !== null ? renderActions?.(projectRead.project) : renderActions !== undefined && <span className="project-title-actions-placeholder" aria-hidden="true"><span className="button">{auth.members}</span><span className="button">{auth.projectSettings}</span></span>}<button className="button" type="button" onClick={() => { graph.refresh(); if (section === "statistics") setStatisticsRefresh(value => value + 1); }} disabled={graph.refreshing}>{graph.refreshing ? m.refreshing : projects.refresh}</button><span className="project-creation-actions"><TaskOrganization projectId={projectId} snapshot={currentSnapshot} displaySnapshot={snapshot} onRefreshGraph={graph.refresh} /><button className="button primary" type="button" onClick={() => setCreatingGoal(true)}>{locale === "zh-CN" ? "新建 Goal" : "New Goal"}</button></span></div>
      </div>
      {creatingGoal && <GoalCreate projectId={projectId} onClose={() => setCreatingGoal(false)} onRefreshGraph={graph.refresh} />}
      {projectRead.error !== null && <section className="snapshot-error" role="alert">
        <p>{locale === "zh-CN" ? "无法读取项目信息。" : "Could not read project information."}</p>
        <button className="button" type="button" onClick={projectRead.retry}>{projects.retry}</button>
      </section>}
      <div className="project-layout">
        <ProjectSectionTabs projectId={projectId} section={section} onChange={selectSection} />
        <div className="project-section-content">
          {sectionIssue !== null && <p className="snapshot-notice" role="status">{preferences.section[sectionIssue.kind]}</p>}
          {tabIssue !== null && <p className="snapshot-notice" role="status">{preferences.tab[tabIssue.kind]}</p>}
          {assigneeIssue !== null && <p className="snapshot-notice" role="status">{preferences.assignee[assigneeIssue.kind]}</p>}
          {statusIssue !== null && <p className="snapshot-notice" role="status">{preferences.status[statusIssue.kind]}</p>}
          {scrollIssue !== null && <p className="snapshot-notice" role="status">{preferences.scroll[scrollIssue.kind]}</p>}
          {snapshot !== null && notice?.kind === "selected-task-removed" && <div className="snapshot-notice snapshot-notice-dismissible" role="status">
            <span className="snapshot-notice-message">{m.selectedTaskRemoved}</span>
            <button className="snapshot-notice-dismiss" type="button" aria-label={m.dismissNotice} title={m.dismissNotice}
              onClick={() => { setNotice(null); heading.current?.focus({ preventScroll: true }); }}><span aria-hidden="true">×</span></button>
          </div>}
          {notice?.kind === "overview-target-unavailable" && <p className="snapshot-notice" role="status">{overview.targetUnavailable}</p>}
          {snapshot !== null && notice?.kind === "overview-tag-check-failed" && <p className="snapshot-notice" role="alert">{locale === "zh-CN" ? "无法核对选中的标签，请重试。" : "Could not check the selected tags. Try again."}</p>}
          <section className="project-section-panel project-overview" id="project-section-panel-overview" role="tabpanel"
            aria-labelledby="project-section-tab-overview" hidden={section !== "overview"} inert={section !== "overview"} tabIndex={0}>
            {section === "overview" && graphState}
            {snapshot !== null && <ProjectOverview snapshot={snapshot} progress={progress} pagination={{ ...overviewPagination, onPageChange: selectOverviewPage }} onNavigate={onOverviewNavigate} onOpenTask={onOpenTask} />}
          </section>
          <section className="project-section-panel" id="project-section-panel-statistics" role="tabpanel"
            aria-labelledby="project-section-tab-statistics" hidden={section !== "statistics"} inert={section !== "statistics"} tabIndex={0}>
            {(statisticsMounted || section === "statistics") && <ProjectStatistics userId={viewer.userId} projectId={projectId}
              repositoryId={prSources.repositoryId}
              sourceError={prSources.error} sourceLoading={prSources.loading} sourceLoaded={prSources.loaded} retrySources={prSources.retry}
              canRead={projectRead.project !== null && !viewer.isInvalidated} active={section === "statistics" && !history.error}
              snapshot={currentSnapshot} taskError={graph.error} onTaskRetry={graph.refresh} refreshRevision={statisticsRefresh} onScrollReady={setStatisticsScrollReady}
              onPrincipalMismatch={viewer.principalMismatch} onAccessError={() => { void projectAccess.session.revalidate(); }} />}
          </section>
          <section className="project-section-panel project-tasks" id="project-section-panel-tasks" role="tabpanel"
            aria-labelledby="project-section-tab-tasks" hidden={section !== "tasks"} inert={section !== "tasks"} tabIndex={0}>
            {section === "tasks" && graphState}
            <TaskSearchWorkspace projectId={projectId} search={search} inputRef={searchInput} onOpenTask={onOpenSearchTask} tagFilter={<TagFilter controller={tagFilter} onManage={() => selectSection("tags")} />} />
            <div hidden={searchActive} inert={searchActive}>
            {snapshot !== null && (tasksMounted || section === "tasks") && <ProjectTaskWorkspace snapshot={snapshot} sessionStore={graph.sessionStore} observationStore={graph.observationStore} pausedTasks={pausedTasks} onOpenPausedTask={onOpenPausedTask} onPausedFocusFallback={onPausedFocusFallback} active={section === "tasks" && !searchActive}
              filter={<div className="project-task-filter-region"><div className="task-list-filters project-task-filters"><TaskAssigneeFilter projectId={projectId} filter={assigneeFilter} onChange={changeAssigneeFilter} /><TaskStatusFilter value={statusFilter} onChange={changeStatusFilter} />{!searchActive && activeView !== "goals" && <label className="task-status-filter"><span>{locale === "zh-CN" ? "平台" : "Platform"}</span><NativeSelect density="filter" touchMode="responsive" focusTone="task" value={platformFilter} onChange={(event) => changePlatformFilter(event.currentTarget.value as PlatformFilter)}><option value="all">{locale === "zh-CN" ? "所有任务" : "All tasks"}</option><option value="any">{locale === "zh-CN" ? "任何平台" : "Any platform"}</option><option value="linux">Linux</option><option value="windows">Windows</option><option value="macos">macOS</option></NativeSelect></label>}{!searchActive && <TagFilter controller={tagFilter} onManage={() => selectSection("tags")} />}{!searchActive && activeView === "goals" && <TagFilter controller={childTagFilter} child />}</div></div>} activeView={activeView} unfinishedStandaloneTaskCount={unfinishedStandaloneTaskCount}
              unfinishedChainCount={unfinishedChainCount} unfinishedGoalCount={unfinishedGoalCount} onViewChange={selectView}
              chains={{ projectId, representativeIds: pageRootIds, allRepresentativeIds: scopedChainIds, scopedMembers, revealTaskId, onRevealed: () => setRevealTaskId(null), onGraphRootChange: setChainOverlay, openGraphTarget, onOpenChain: (id, trigger) => onOpenListChain(id, trigger, null), onCloseChain, onRestoreGraphFocus: restoreGraphFocus, onNavigateExternalTask: onNavigateExternalChain,
                onOpenTask: (id, trigger) => trigger.closest(".task-chain-dialog") !== null ? onOpenChainTask(id, trigger) : onOpenListTask(id, trigger, null), onOpenSession,
                pagination: { ...chainPagination, onPageChange: selectChainPage } }}
              standalone={{ projectId, taskIds: pageStandaloneIds, allTaskIds: scopedStandaloneIds, onOpenSession, onSelectTask: (id, trigger) => onOpenListTask(id, trigger, null),
                pagination: { ...standalonePagination, onPageChange: selectStandalonePage } }}
              goals={{ projectId, goals: pageGoals, childTagFilter, total: allGoals.length, onOpenGoal: onOpenTask, onOpenGoalGraph, onOpenGoalGraphTask: onOpenTask, graphError: graph.error, onRefreshGraph: graph.refresh, pagination: goalPagination,
                openGraphTarget, onCloseChain, onRestoreGraphFocus: restoreGraphFocus, onNavigateExternalTask: onNavigateExternalChain,
                onOpenTask: onOpenChainTask, onOpenListTask, onOpenListChain, onGraphRootChange: setChainOverlay, onOpenSession }} />}
            </div>
          </section>
          <section className="project-section-panel project-prs" id="project-section-panel-prs" role="tabpanel"
            aria-labelledby="project-section-tab-prs" hidden={section !== "prs"} inert={section !== "prs"} tabIndex={0}>
            <PullRequestWorkspace userId={viewer.userId} projectId={projectId}
              repositories={prSources.repositories} currentRepositoryId={prSources.currentRepositoryId} repositoryId={prSources.repositoryId}
              setRepositoryId={prSources.setRepositoryId} sourceLoading={prSources.loading} sourceLoaded={prSources.loaded}
              sourceError={prSources.error} retrySources={prSources.retry}
              canRead={projectRead.project !== null && !viewer.isInvalidated}
              active={section === "prs" && !history.error} onScrollReady={setPRScrollReady}
              onPrincipalMismatch={viewer.principalMismatch}
              onAccessError={() => { void projectAccess.session.revalidate(); }} />
          </section>
          <section className="project-section-panel" id="project-section-panel-tags" role="tabpanel"
            aria-labelledby="project-section-tab-tags" hidden={section !== "tags"} inert={section !== "tags"} tabIndex={0}>
            {(tagsMounted || section === "tags") && <ProjectTags projectId={projectId} active={section === "tags"} onScrollReady={setTagScrollReady} />}
          </section>
        </div>
      </div>
      <OverlayOwnerContext value={detailOwner}>{detailDialog}</OverlayOwnerContext>
      </div>
    </TaskExecutionClockProvider>
  );
};

export const ProjectPage = ({ projectId, renderActions }: { readonly projectId: string; readonly renderActions?: (project: Project) => ReactNode }) => <ProjectAccessBoundary projectId={projectId}><TaskDetailSessionBoundary><ProjectView key={projectId} projectId={projectId} {...(renderActions === undefined ? {} : { renderActions })} /></TaskDetailSessionBoundary></ProjectAccessBoundary>;
