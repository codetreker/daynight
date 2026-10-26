import { getFormats } from "../../formats";
import type { WorkspaceMessages } from "../workspace";

const { number } = getFormats("zh-CN");

export const workspace: WorkspaceMessages = {
  app: {
    skipToContent: "跳到主要内容", workspaceNavigation: "工作空间导航", projectHome: "Daynight 项目首页", mainNavigation: "主导航", workspace: "工作空间", projects: "项目", projectTasks: "项目任务", localWorkspace: "本地工作空间", localWorkspaceDetail: "任务与依赖，一处看清", localLabel: "工作空间 · 本地", breadcrumb: "面包屑", notFound: "页面不存在", notFoundDetail: "请检查页面地址，或返回项目列表。", returnToProjects: "返回项目列表",
    documentTitle: { task: "任务详情 · Daynight", attachment: "任务详情 · Daynight", projects: "项目 · Daynight", project: "项目任务 · Daynight", notFound: "页面不存在 · Daynight" },
  },
  projects: {
    subtitle: "从项目出发，查看任务进度与执行依赖。", refresh: "刷新", retry: "重试", loading: "正在加载项目", loadingDetail: "正在读取工作空间中的项目。", loadingFailed: "项目加载失败", networkError: "无法连接服务，请检查本地服务后重试。", readError: "暂时无法读取项目，请重试。", empty: "还没有项目", emptyDetail: "通过 API 创建项目后，点击刷新即可在这里查看。", list: "项目列表", createdOn: ({ date }) => `创建于 ${date}`, viewTasks: "查看任务", moreFailed: "更多项目加载失败，已加载的项目仍可查看。", loadingMore: "正在加载更多…", retryMore: "重试加载更多", loadMore: "加载更多", allLoaded: "已加载全部项目",
  },
  project: {
    back: "← 项目", lastRefreshed: ({ time }) => `最近成功刷新 ${time}`, refreshing: "正在刷新…", loading: "正在加载任务图", loadingDetail: "正在读取项目任务和依赖关系。", notFound: "项目不存在", graphLimit: "任务图超过展示上限", incomplete: "任务图数据不完整", loadingFailed: "项目加载失败", networkError: "无法连接服务，请检查本地服务后重试。", protocolError: "任务图数据不完整或不一致，请重试。", notFoundDetail: "这个项目不存在，请返回项目列表。", graphLimitDetail: "完整任务图超过当前支持的展示规模。", readError: "暂时无法读取任务图，请重试。",
    graphLimitCounts: ({ nodes, edges, maxNodes, maxEdges }) => `当前 ${number(nodes)} 个任务、${number(edges)} 条依赖；支持最多 ${number(maxNodes)} 个任务、${number(maxEdges)} 条依赖。`,
    refreshFailed: "刷新失败", showingSnapshot: "仍显示上次成功读取的数据。", retryRefresh: "重试刷新", selectedTaskRemoved: "所选任务已不在新的任务图中，详情已关闭。", statistics: "项目任务统计", totalTasks: "任务总数", uniqueTasks: "按任务 ID 去重", completion: ({ percent }) => `完成比例 ${number(percent)}%`, waiting: "等待开始", advancing: "正在推进", ready: "可开始", blocked: "被阻塞", todoSubset: "待处理的子集", empty: "还没有任务", emptyDetail: "项目中的任务会显示在这里。创建任务后，点击刷新查看。", chains: "任务依赖链",
  },
  overview: {
    heading: "整体进度", standalone: "独立任务", standaloneScope: "未完成任务 + 最近 7 天完成的任务",
    allCompleted: "所有任务均已完成", allCompletedDetail: "当前没有未完成的任务链或独立任务。",
    targetUnavailable: "对应的任务分组已不可见，请从任务列表选择任务。",
    rowLabel: ({ title, done, total, percent }) => `${title}，已完成 ${number(done)} / ${number(total)}，${number(percent)}%，前往任务列表`,
  },
  standalone: {
    list: "独立任务列表", showCompletedCount: ({ count }) => `显示已完成独立任务（${number(count)}）`, summary: ({ visible, total }) => `最新创建在前 · ${number(visible)} / ${number(total)} 个独立任务`, summaryLabel: ({ visible, total }) => `显示 ${number(visible)} 个，共 ${number(total)} 个独立任务`, explanation: "按创建时间倒序排列。独立任务没有普通前置或普通后续依赖；外部前置仍可能阻塞执行，点击任务直接查看详情。", empty: "暂无独立任务", emptyDetail: "当前任务均由普通依赖连接为任务链，可在任务链页签查看。", allCompleted: "所有独立任务已完成", hiddenCompleted: ({ count }) => `已隐藏 ${number(count)} 个已完成独立任务，项目统计仍包含全部任务。`, showCompleted: "显示已完成独立任务", createdOn: ({ date }) => `创建于 ${date}`,
  },
  sections: { label: "项目视图", overview: "概览", tasks: "任务列表", overviewDescription: "查看项目整体进展与当前任务状态。", tasksDescription: "浏览独立任务与按依赖关联的任务链。" },
  tabs: { label: "项目任务视图", standalone: "独立任务", chains: "任务链", unfinishedCount: "未完成任务数" },
  preferences: {
    section: { read: "无法读取浏览器保存的项目视图，本次浏览仍可正常使用。", invalid: "浏览器保存的项目视图无效，已默认显示概览，本次浏览仍可正常使用。", write: "项目视图无法保存到浏览器，刷新后可能无法恢复，本次浏览仍可正常使用。" },
    completedChains: { read: "无法读取浏览器保存的已完成任务链显示偏好，本次浏览仍可正常使用。", invalid: "浏览器保存的已完成任务链显示偏好无效，已默认隐藏，本次浏览仍可正常使用。", write: "已完成任务链显示偏好无法保存到浏览器，刷新后可能无法恢复，本次浏览仍可正常使用。" },
    tab: { read: "无法读取浏览器保存的任务页签，本次浏览仍可正常使用。", invalid: "浏览器保存的任务页签无效，已默认显示任务链，本次浏览仍可正常使用。", write: "任务页签无法保存到浏览器，刷新后可能无法恢复，本次浏览仍可正常使用。" },
    standalone: { read: "无法读取浏览器保存的已完成独立任务显示偏好，本次浏览仍可正常使用。", invalid: "浏览器保存的已完成独立任务显示偏好无效，已默认隐藏，本次浏览仍可正常使用。", write: "已完成独立任务显示偏好无法保存到浏览器，刷新后可能无法恢复，本次浏览仍可正常使用。" },
    scroll: { read: "无法读取浏览器保存的任务浏览位置，本次浏览仍可正常使用。", invalid: "浏览器保存的任务浏览位置无效，已从顶部开始，本次浏览仍可正常使用。", write: "任务浏览位置无法保存到浏览器，刷新后可能无法恢复，本次浏览仍可正常使用。" },
  },
};
