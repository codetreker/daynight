import { getFormats } from "../../formats";
import type { WorkspaceMessages } from "../workspace";

const { number } = getFormats("en");

export const workspace: WorkspaceMessages = {
  app: {
    skipToContent: "Skip to main content", workspaceNavigation: "Workspace navigation", projectHome: "Daynight project home", mainNavigation: "Main navigation",
    workspace: "Workspace", projects: "Projects", projectTasks: "Project tasks", localWorkspace: "Local workspace", localWorkspaceDetail: "Tasks and dependencies at a glance",
    localLabel: "Workspace · Local", breadcrumb: "Breadcrumb", notFound: "Page not found", notFoundDetail: "Check the page address or return to the project list.", returnToProjects: "Back to projects",
    documentTitle: { task: "Task details · Daynight", attachment: "Task details · Daynight", projects: "Projects · Daynight", project: "Project tasks · Daynight", notFound: "Page not found · Daynight" },
  },
  projects: {
    subtitle: "Explore task progress and dependencies by project.", refresh: "Refresh", retry: "Retry", loading: "Loading projects", loadingDetail: "Reading projects in this workspace.",
    loadingFailed: "Projects could not be loaded", networkError: "Cannot connect to the service. Check the local service and try again.", readError: "Projects cannot be read right now. Try again.",
    empty: "No projects yet", emptyDetail: "Create a project through the API, then refresh to see it here.", list: "Project list", createdOn: ({ date }) => `Created on ${date}`, viewTasks: "View tasks",
    moreFailed: "More projects could not be loaded. Previously loaded projects remain available.", loadingMore: "Loading more…", retryMore: "Retry loading more", loadMore: "Load more", allLoaded: "All projects loaded",
  },
  project: {
    back: "← Projects", lastRefreshed: ({ time }) => `Last successful refresh ${time}`, refreshing: "Refreshing…", loading: "Loading task graph", loadingDetail: "Reading project tasks and dependencies.",
    notFound: "Project not found", graphLimit: "Task graph exceeds the display limit", incomplete: "Task graph data is incomplete", loadingFailed: "Project could not be loaded",
    networkError: "Cannot connect to the service. Check the local service and try again.", protocolError: "Task graph data is incomplete or inconsistent. Try again.",
    notFoundDetail: "This project does not exist. Return to the project list.", graphLimitDetail: "The complete task graph exceeds the supported display size.", readError: "The task graph cannot be read right now. Try again.",
    graphLimitCounts: ({ nodes, edges, maxNodes, maxEdges }) => `The graph has ${number(nodes)} ${nodes === 1 ? "task" : "tasks"} and ${number(edges)} ${edges === 1 ? "dependency" : "dependencies"}; up to ${number(maxNodes)} ${maxNodes === 1 ? "task" : "tasks"} and ${number(maxEdges)} ${maxEdges === 1 ? "dependency" : "dependencies"} are supported.`,
    refreshFailed: "Refresh failed", showingSnapshot: "Showing the last successfully loaded data.", retryRefresh: "Retry refresh", selectedTaskRemoved: "The selected task is no longer in the updated task graph. Its details have been closed.", dismissNotice: "Dismiss notification",
    statistics: "Project task statistics", totalTasks: "Total tasks", uniqueTasks: "Unique task IDs", completion: ({ percent }) => `${number(percent)}% complete`, waiting: "Waiting to start", advancing: "Work in progress", ready: "Ready", blocked: "Blocked", todoSubset: "A subset of to-do tasks", empty: "No tasks yet", emptyDetail: "Project tasks will appear here. Create a task, then refresh to see it.", chains: "Task dependency chains",
  },
  overview: {
    heading: "Overall progress", standalone: "Standalone tasks", standaloneScope: "Unfinished tasks + tasks completed today or in the previous 6 days",
    allCompleted: "No recent tasks", allCompletedDetail: "There are no unfinished tasks or tasks completed today or in the previous 6 days.",
    targetUnavailable: "That task group is no longer visible. Choose a task from the task list.",
    rowLabel: ({ title, done, total, percent }) => `${title}, ${number(done)} / ${number(total)} complete, ${number(percent)}%, view task list`,
  },
  standalone: {
    list: "Standalone task list",
    summary: ({ visible, total }) => `Newest first · ${number(visible)} / ${number(total)} standalone ${total === 1 ? "task" : "tasks"}`,
    summaryLabel: ({ visible, total }) => `Showing ${number(visible)} of ${number(total)} standalone ${total === 1 ? "task" : "tasks"}`,
    explanation: "Sorted by creation time, newest first. Unfinished tasks and tasks completed today or in the previous 6 days are shown by default. Standalone tasks have no ordinary dependencies or successors. External prerequisites can still block execution. Select a task to view its details.", empty: "No standalone tasks", emptyDetail: "All current tasks are connected by ordinary dependencies. View them in the task chains tab.", allCompleted: "No recent standalone tasks",
    hiddenCompleted: ({ count }) => `${number(count)} completed standalone ${count === 1 ? "task is" : "tasks are"} outside the current filter. Select “Show all” to view them.`, showAll: "Show all", createdOn: ({ date }) => `Created on ${date}`,
  },
  pagination: {
    label: ({ list }) => `${list} pagination`, range: ({ start, end, total }) => `${number(start)}–${number(end)} of ${number(total)}`,
    page: ({ page, pages }) => `Page ${number(page)} of ${number(pages)}`, previous: "Previous", next: "Next",
  },
  sections: { label: "Project views", overview: "Overview", tasks: "Task list", overviewDescription: "View overall progress and current task status.", tasksDescription: "Browse standalone tasks and dependency chains." },
  tabs: { label: "Project task views", standalone: "Standalone tasks", chains: "Task chains", unfinishedCount: "Unfinished task count" },
  preferences: {
    section: { read: "The saved project view could not be read. You can continue browsing.", invalid: "The saved project view is invalid. Overview is shown by default. You can continue browsing.", write: "The project view could not be saved. It may not return after a reload. You can continue browsing." },
    completedChains: { read: "The saved task chain “Show all” preference could not be read. You can continue browsing.", invalid: "The saved task chain “Show all” preference is invalid. Recent chains are shown by default. You can continue browsing.", write: "The task chain “Show all” preference could not be saved. It may not return after a reload. You can continue browsing." },
    tab: { read: "The saved task tab could not be read. You can continue browsing.", invalid: "The saved task tab is invalid. Task chains are shown by default. You can continue browsing.", write: "The task tab could not be saved. It may not return after a reload. You can continue browsing." },
    standalone: { read: "The saved standalone task “Show all” preference could not be read. You can continue browsing.", invalid: "The saved standalone task “Show all” preference is invalid. Recent tasks are shown by default. You can continue browsing.", write: "The standalone task “Show all” preference could not be saved. It may not return after a reload. You can continue browsing." },
    scroll: { read: "The saved task browsing position could not be read. You can continue browsing.", invalid: "The saved task browsing position is invalid. Browsing starts at the top. You can continue browsing.", write: "The task browsing position could not be saved. It may not return after a reload. You can continue browsing." },
  },
};
