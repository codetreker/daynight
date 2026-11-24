export const settingsWorkspaceMessages = {
  'zh-CN': {
    sync: { title: '任务同步', description: '从服务器重新同步此项目的全部 Task 和 Goal，更新此浏览器中的任务缓存。', action: '重新同步', busy: '正在同步…', retry: '重试', success: '任务已同步。', empty: '任务已同步。此项目没有任务。', failure: '任务同步失败。已保留此浏览器中的任务缓存。', denied: '你没有此项目的任务读取权限。' },
    navigation: '项目设置分组',
    execution: '执行与提醒', prompts: 'Worker 提示词', github: 'GitHub 集成', members: '成员与邀请', management: '项目管理',
    dirty: '未保存', pending: '处理中', attention: '需处理',
    invalid: '设置分组地址无效。', recover: '返回执行与提醒',
  },
  en: {
    sync: { title: 'Task sync', description: 'Resync all Tasks and Goals in this project from the server to update this browser’s task cache.', action: 'Resync', busy: 'Syncing…', retry: 'Retry', success: 'Tasks synced.', empty: 'Tasks synced. This project has no tasks.', failure: 'Task sync failed. This browser’s task cache was retained.', denied: 'You do not have permission to read tasks in this project.' },
    navigation: 'Project settings sections',
    execution: 'Execution & alerts', prompts: 'Worker prompts', github: 'GitHub integration', members: 'Members & invitations', management: 'Project management',
    dirty: 'Unsaved', pending: 'In progress', attention: 'Needs attention',
    invalid: 'Invalid settings section.', recover: 'Open execution & alerts',
  },
} as const;
