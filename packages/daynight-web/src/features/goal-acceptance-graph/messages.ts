export const goalAcceptanceMessages = (locale: string) => locale === 'zh-CN' ? {
  title: 'Goal 验收依赖图', open: '验收依赖图', canvas: 'Goal 验收依赖画布', close: '关闭验收依赖图',
  empty: '当前项目没有待办或进行中的 Goal。', inspect: '选择 Goal 查看已知关系', prerequisites: '前置 Goal', successors: '下游 Goal',
  knownOnly: '本项目已知关系 · 全局验收待核验', none: '无本项目已知关系', satisfied: '已满足', blocking: '阻塞验收',
  progress: (done: number, total: number) => `${done} / ${total} 子 Task 已完成`,
  details: '详情', fit: '查看全图', count: (goals: number, edges: number) => `${goals} 个 Goal · ${edges} 条验收依赖`,
} : {
  title: 'Goal acceptance dependencies', open: 'Acceptance graph', canvas: 'Goal acceptance dependency canvas', close: 'Close acceptance graph',
  empty: 'This project has no todo or in-progress Goals.', inspect: 'Select a Goal to inspect known relationships', prerequisites: 'Prerequisite Goals', successors: 'Dependent Goals',
  knownOnly: 'Known project relationships · Global acceptance is unverified', none: 'No known relationships in this project', satisfied: 'Satisfied', blocking: 'Blocks acceptance',
  progress: (done: number, total: number) => `${done} / ${total} child Tasks done`,
  details: 'Details', fit: 'Show all Goals', count: (goals: number, edges: number) => `${goals} Goals · ${edges} acceptance dependencies`,
};
