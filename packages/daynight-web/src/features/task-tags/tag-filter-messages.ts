export const tagFilterMessages = {
  en: {
    manage: 'Manage tags', title: 'Tag filter', child: 'Child task tag filter', clear: 'Clear filters',
    search: 'Find tags', clearSearch: 'Clear tag search', clearQuery: 'Clear search',
    match: 'Match', all: 'All selected', any: 'Any selected', untagged: 'Untagged only',
    matchSingle: 'Choose at least two tags to change matching.', matchUntagged: 'Matching does not apply to untagged items.',
    invalid: 'A selected tag is unavailable. Remove it to search again.', removed: 'unavailable', remove: 'Remove',
    loading: 'Loading tags…', empty: 'No project tags yet.', noMatches: 'No matching tags.',
    error: 'Could not load tags.', resolveError: 'Could not check selected tags.', retry: 'Retry', next: 'Next page', first: 'First page',
  },
  'zh-CN': {
    manage: '管理标签', title: '标签筛选', child: '子 Task 标签筛选', clear: '清空筛选',
    search: '查找标签', clearSearch: '清空查找词', clearQuery: '清空查找',
    match: '匹配方式', all: '全部满足', any: '满足任一', untagged: '仅无标签',
    matchSingle: '选择至少两个标签时可切换匹配方式。', matchUntagged: '仅无标签不使用匹配方式。',
    invalid: '选中的标签已不可用，请移除后重新查询。', removed: '已不可用', remove: '移除',
    loading: '正在读取标签…', empty: '项目中还没有标签。', noMatches: '没有找到匹配的标签。',
    error: '无法读取标签。', resolveError: '无法核对选中的标签。', retry: '重试', next: '下一页', first: '首页',
  },
} as const;
