import { getFormats } from "../../formats";
import type { WorkspaceMessages } from "../workspace";

const { number } = getFormats("zh-CN");

export const workspace: WorkspaceMessages = {
  app: {
    skipToContent: "跳到主要内容", workspaceNavigation: "工作空间导航", projectHome: "Daynight 项目首页", mainNavigation: "主导航", workspace: "工作空间", my: "我的", tools: "工具", projects: "项目", projectTasks: "项目任务", localWorkspace: "本地工作空间", localWorkspaceDetail: "任务与依赖，一处看清", localLabel: "工作空间 · 本地", breadcrumb: "面包屑", notFound: "页面不存在", notFoundDetail: "请检查页面地址，或返回项目列表。", returnToProjects: "返回项目列表",
    documentTitle: { task: "任务详情 · Daynight", attachment: "任务详情 · Daynight", projects: "项目 · Daynight", project: "项目任务 · Daynight", notFound: "页面不存在 · Daynight" },
  },
  projects: {
    subtitle: "从项目出发，查看任务进度与执行依赖。", refresh: "刷新", retry: "重试", loading: "正在加载项目", loadingDetail: "正在读取工作空间中的项目。", loadingFailed: "项目加载失败", networkError: "无法连接服务，请检查本地服务后重试。", readError: "暂时无法读取项目，请重试。", empty: "还没有项目", emptyDetail: "通过 API 创建项目后，点击刷新即可在这里查看。", list: "项目列表", createdOn: ({ date }) => `创建于 ${date}`, viewTasks: "查看任务", moreFailed: "更多项目加载失败，已加载的项目仍可查看。", loadingMore: "正在加载更多…", retryMore: "重试加载更多", loadMore: "加载更多", allLoaded: "已加载全部项目",
  },
  project: {
    statusFilter: "状态", allStatuses: "全部状态", statusOptions: { proposed: "待确认", todo: "待办", in_progress: "进行中", done: "已完成", cancelled: "已取消" },
    back: "← 项目", lastRefreshed: ({ time }) => `最近成功刷新 ${time}`, refreshing: "正在刷新…", loading: "正在加载任务图", loadingDetail: "正在读取项目任务和依赖关系。", notFound: "项目不存在", incomplete: "任务图数据不完整", loadingFailed: "项目加载失败", networkError: "无法连接服务，请检查本地服务后重试。", protocolError: "任务图数据不完整或不一致，请重试。", notFoundDetail: "这个项目不存在，请返回项目列表。", readError: "暂时无法读取任务图，请重试。",
    refreshFailed: "刷新失败", showingSnapshot: "仍显示上次成功读取的数据。", retryRefresh: "重试刷新", selectedTaskRemoved: "所选任务已不在新的任务图中，详情已关闭。", dismissNotice: "关闭提示", statistics: "项目任务统计", totalTasks: "任务总数", uniqueTasks: "按任务 ID 去重", completion: ({ percent }) => `完成比例 ${number(percent)}%`, endedBreakdown: ({ done, cancelled, percent }) => `${number(done)} 完成 · ${number(cancelled)} 取消 · ${number(percent)}% 已结束`, waiting: "等待开始", advancing: "正在推进", ready: "可开始", blocked: "被阻塞", todoSubset: "待处理的子集", empty: "还没有任务", emptyDetail: "项目中的任务会显示在这里。创建任务后，点击刷新查看。", chains: "任务依赖链",
  },
  search: {
    form: "搜索项目任务", input: "搜索任务 ID、标题和描述", placeholder: "搜索 ID、标题和描述，支持 AND、OR、NOT…", submit: "搜索", clear: "清空搜索",
    help: "搜索语法", helpDescription: "搜索当前项目的任务 ID、完整标题和描述。", helpExamples: '空格表示 AND；支持 OR、NOT、括号、引号短语以及 id:、title: 和 description:。例如：id:05d609a8 OR title:缓存',
    heading: "搜索结果", applied: ({ query }) => `搜索结果：${query}`, empty: "未找到匹配任务", loading: "正在搜索任务…",
    failed: "无法完成搜索。", stale: "仍显示上次成功的结果；刷新失败。", syntax: ({ position, reason }) => `搜索语法第 ${position} 个字符：${reason}`,
    reasons: { empty_query: "请输入表达式。", empty_phrase: "短语不能为空。", expected_operand: "此处需要表达式。", field_group_not_supported: "字段不能限定括号组。", invalid_escape: "只能转义引号或反斜杠。", missing_field_value: "字段需要一个值。", nesting_too_deep: "括号嵌套过深。", query_too_large: "表达式过长。", too_many_terms: "表达式条件过多。", unclosed_group: "请闭合括号。", unclosed_quote: "请闭合引号。", unexpected_closing_group: "多余的右括号。", unexpected_token: "出现意外内容。", unknown_field: "未知字段；请使用 id、title 或 description。" },
    open: ({ title }) => `打开任务：${title}`, idMatch: "ID 命中", titleMatch: "标题命中", descriptionMatch: "描述命中", negativeMatch: "否定条件", updated: ({ date }) => `更新于 ${date}`,
  },
  overview: {
    heading: "整体进度", standalone: "独立任务", standaloneScope: "未完成任务 + 今天及前 6 天完成的任务",
    allCompleted: "暂无近期任务", allCompletedDetail: "当前没有未完成或今天及前 6 天完成的任务链与独立任务。",
    targetUnavailable: "对应的任务分组已不可见，请从任务列表选择任务。",
    rowLabel: ({ title, done, total, percent }) => `${title}，已完成 ${number(done)} / ${number(total)}，${number(percent)}%，前往任务列表`,
  },
  standalone: {
    list: "独立任务列表", summary: ({ visible, total }) => `最新创建在前 · ${number(visible)} / ${number(total)} 个独立任务`, summaryLabel: ({ visible, total }) => `显示 ${number(visible)} 个，共 ${number(total)} 个独立任务`, empty: "暂无独立任务", emptyDetail: "未归属 Goal 的独立任务将显示在这里。", createdOn: ({ date }) => `创建于 ${date}`,
  },
  pagination: {
    label: ({ list }) => `${list}分页`, range: ({ start, end, total }) => `第 ${number(start)}–${number(end)} 条，共 ${number(total)} 条`,
    page: ({ page, pages }) => `第 ${number(page)} / ${number(pages)} 页`, previous: "上一页", next: "下一页",
  },
  sections: { tags: "标签", label: "项目视图", overview: "概览", tasks: "任务列表", prs: "PR 列表", overviewDescription: "查看项目整体进展与当前任务状态。", tasksDescription: "浏览独立任务与按依赖关联的任务链。" },
  tabs: { label: "项目任务视图", standalone: "独立任务", chains: "任务链", goals: "Goal", unfinishedCount: "未完成任务数", unfinishedGoalCount: "未完成 Goal 数" },
  goals: { details: "Goal 详情", detailsLabel: ({ title }) => `${title}，Goal 详情`, toggle: ({ title, expanded }) => `${expanded ? "收起" : "展开"} Goal：${title}`, emptyTasks: "此 Goal 暂无子任务。", list: "Goal", empty: "暂无 Goal", emptyDetail: "Goal 将显示在这里。", summary: ({ shown, total }) => `${number(shown)} / ${number(total)} 个 Goal`, composition: ({ count }) => `共 ${number(count)} 个任务` },
  preferences: {
    section: { read: "无法读取浏览器保存的项目视图，本次浏览仍可正常使用。", invalid: "浏览器保存的项目视图无效，已默认显示概览，本次浏览仍可正常使用。", write: "项目视图无法保存到浏览器，刷新后可能无法恢复，本次浏览仍可正常使用。" },
    tab: { read: "无法读取浏览器保存的任务页签，本次浏览仍可正常使用。", invalid: "浏览器保存的任务页签无效，已默认显示任务链，本次浏览仍可正常使用。", write: "任务页签无法保存到浏览器，刷新后可能无法恢复，本次浏览仍可正常使用。" },
    assignee: { read: "无法读取浏览器保存的负责人筛选，本次浏览仍可正常使用。", invalid: "浏览器保存的负责人筛选无效，已默认显示所有负责人，本次浏览仍可正常使用。", write: "负责人筛选无法保存到浏览器，刷新后可能无法恢复，本次浏览仍可正常使用。" },
    scroll: { read: "无法读取浏览器保存的任务浏览位置，本次浏览仍可正常使用。", invalid: "浏览器保存的任务浏览位置无效，已从顶部开始，本次浏览仍可正常使用。", write: "任务浏览位置无法保存到浏览器，刷新后可能无法恢复，本次浏览仍可正常使用。" },
  },
};
