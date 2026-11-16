import { getFormats } from "../../formats";
import type { WorkspaceMessages } from "../workspace";

const { number } = getFormats("en");

export const workspace: WorkspaceMessages = {
  app: {
    skipToContent: "Skip to main content", workspaceNavigation: "Workspace navigation", projectHome: "Daynight project home", mainNavigation: "Main navigation",
    workspace: "Workspace", my: "My", tools: "Tools", projects: "Projects", projectTasks: "Project tasks", localWorkspace: "Local workspace", localWorkspaceDetail: "Tasks and dependencies at a glance",
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
    statusFilter: "Status", allStatuses: "All statuses", statusOptions: { proposed: "Proposed", todo: "To do", in_progress: "In progress", done: "Done", cancelled: "Cancelled" },
    back: "← Projects", lastRefreshed: ({ time }) => `Last successful refresh ${time}`, refreshing: "Refreshing…", loading: "Loading task graph", loadingDetail: "Reading project tasks and dependencies.",
    notFound: "Project not found", incomplete: "Task graph data is incomplete", loadingFailed: "Project could not be loaded",
    networkError: "Cannot connect to the service. Check the local service and try again.", protocolError: "Task graph data is incomplete or inconsistent. Try again.",
    notFoundDetail: "This project does not exist. Return to the project list.", readError: "The task graph cannot be read right now. Try again.",
    refreshFailed: "Refresh failed", showingSnapshot: "Showing the last successfully loaded data.", retryRefresh: "Retry refresh", selectedTaskRemoved: "The selected task is no longer in the updated task graph. Its details have been closed.", dismissNotice: "Dismiss notification",
    statistics: "Project task statistics", totalTasks: "Total tasks", uniqueTasks: "Unique task IDs", completion: ({ percent }) => `${number(percent)}% complete`, endedBreakdown: ({ done, cancelled, percent }) => `${number(done)} completed · ${number(cancelled)} cancelled · ${number(percent)}% ended`, waiting: "Waiting to start", advancing: "Work in progress", ready: "Ready", blocked: "Blocked", todoSubset: "A subset of to-do tasks", empty: "No tasks yet", emptyDetail: "Project tasks will appear here. Create a task, then refresh to see it.", chains: "Task dependency chains",
  },
  search: {
    form: "Search project tasks", input: "Search task IDs, titles and descriptions", placeholder: "Search IDs, titles and descriptions with AND, OR, NOT…", submit: "Search", clear: "Clear search",
    help: "Search syntax", helpDescription: "Search task IDs, complete titles and descriptions in this project.", helpExamples: 'Use spaces for AND, OR, NOT, parentheses, quoted phrases, id:, title: and description:. For example: id:05d609a8 OR title:cache',
    heading: "Search results", applied: ({ query }) => `Results for: ${query}`, empty: "No matching tasks", loading: "Searching tasks…",
    failed: "Search could not be completed.", stale: "Showing the last successful results; refresh failed.", syntax: ({ position, reason }) => `Search syntax at character ${position}: ${reason}`,
    reasons: { empty_query: "Enter an expression.", empty_phrase: "A phrase cannot be empty.", expected_operand: "An expression is required here.", field_group_not_supported: "Fields cannot be applied to a group.", invalid_escape: "Use only escaped quotes or backslashes.", missing_field_value: "A field needs a value.", nesting_too_deep: "Too many nested groups.", query_too_large: "The expression is too long.", too_many_terms: "The expression has too many terms.", unclosed_group: "Close the parentheses.", unclosed_quote: "Close the quoted phrase.", unexpected_closing_group: "Unexpected closing parenthesis.", unexpected_token: "Unexpected token.", unknown_field: "Unknown field; use id, title or description." },
    open: ({ title }) => `Open task: ${title}`, idMatch: "ID match", titleMatch: "Title match", descriptionMatch: "Description match", negativeMatch: "Negative condition", updated: ({ date }) => `Updated ${date}`,
  },
  overview: {
    heading: "Overall progress", standalone: "Standalone tasks", standaloneScope: "Unfinished tasks + tasks completed today or in the previous 6 days",
    allCompleted: "No recent tasks", allCompletedDetail: "There are no unfinished tasks or tasks completed today or in the previous 6 days.",
    targetUnavailable: "That task group is no longer visible. Choose a task from the task list.",
    rowLabel: ({ title, done, total, percent }) => `${title}, ${number(done)} / ${number(total)} completed, ${number(percent)}%, view task list`,
  },
  standalone: {
    list: "Standalone task list",
    summary: ({ visible, total }) => `Newest first · ${number(visible)} / ${number(total)} standalone ${total === 1 ? "task" : "tasks"}`,
    summaryLabel: ({ visible, total }) => `Showing ${number(visible)} of ${number(total)} standalone ${total === 1 ? "task" : "tasks"}`,
    empty: "No standalone tasks", emptyDetail: "Standalone tasks outside a Goal will appear here.", createdOn: ({ date }) => `Created on ${date}`,
  },
  pagination: {
    label: ({ list }) => `${list} pagination`, range: ({ start, end, total }) => `${number(start)}–${number(end)} of ${number(total)}`,
    page: ({ page, pages }) => `Page ${number(page)} of ${number(pages)}`, previous: "Previous", next: "Next",
  },
  sections: { tags: "Tags", label: "Project views", overview: "Overview", tasks: "Task list", prs: "PR list", overviewDescription: "View overall progress and current task status.", tasksDescription: "Browse standalone tasks and dependency chains." },
  tabs: { label: "Project task views", standalone: "Standalone tasks", chains: "Task chains", goals: "Goals", unfinishedCount: "Unfinished task count", unfinishedChainCount: "Unfinished task chain count", unfinishedGoalCount: "Unfinished Goal count" },
  goals: { details: "Goal details", detailsLabel: ({ title }) => `${title}, Goal details`, toggle: ({ title, expanded }) => `${expanded ? "Collapse" : "Expand"} Goal: ${title}`, emptyTasks: "No tasks in this Goal.", list: "Goals", empty: "No goals yet", emptyDetail: "Goals will appear here.", summary: ({ shown, total }) => `${number(shown)} of ${number(total)} goals`, composition: ({ count }) => `${number(count)} tasks` },
  preferences: {
    section: { read: "The saved project view could not be read. You can continue browsing.", invalid: "The saved project view is invalid. Overview is shown by default. You can continue browsing.", write: "The project view could not be saved. It may not return after a reload. You can continue browsing." },
    tab: { read: "The saved task tab could not be read. You can continue browsing.", invalid: "The saved task tab is invalid. Task chains are shown by default. You can continue browsing.", write: "The task tab could not be saved. It may not return after a reload. You can continue browsing." },
    assignee: { read: "The saved assignee filter could not be read. You can continue browsing.", invalid: "The saved assignee filter is invalid. All assignees are shown by default. You can continue browsing.", write: "The assignee filter could not be saved. It may not return after a reload. You can continue browsing." },
    scroll: { read: "The saved task browsing position could not be read. You can continue browsing.", invalid: "The saved task browsing position is invalid. Browsing starts at the top. You can continue browsing.", write: "The task browsing position could not be saved. It may not return after a reload. You can continue browsing." },
  },
};
