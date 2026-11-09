export const stableDiagrams = [
  { name: 'flowchart', source: 'flowchart TD\nA[开始] --> B[完成]', labels: ['开始', '完成'] },
  { name: 'flowchart-elk', source: 'flowchart-elk LR\nA[Left] --> B[Right]', labels: ['Left', 'Right'] },
  { name: 'sequence', source: `sequenceDiagram
  participant C as Web / CLI
  participant S as 删除用例
  participant P as Project 行
  participant T as 全部 Task 行
  participant D as 事务内 DAO
  C->>S: DELETE Project ID
  S->>P: 锁定 live Project
  S->>T: 按 UUID 锁定全部 Task
  S->>D: 当前授权与 Worker 属性校验
  alt 存在 active claim 或没有删除权
    S-->>C: 明确拒绝，零业务修改
  else 允许删除
    S->>D: 标记 Project + 撤回 Session + epoch
    D-->>S: commit confirmed
    S->>S: 本实例内存撤回，其他实例由既有轮询退出
    S-->>C: 已确认删除回执
  end`, labels: ['Web / CLI', '删除用例', 'Project 行', '全部 Task 行', '事务内 DAO', '存在 active claim', '允许删除', 'commit confirmed', '本实例内存撤回', '已确认删除回执'] },
  { name: 'class', source: 'classDiagram\nclass Project\nclass Task\nProject --> Task : 包含', labels: ['Project', 'Task', '包含'] },
  { name: 'state', source: 'stateDiagram-v2\n[*] --> Ready\nReady --> Done: 确认', labels: ['Ready', 'Done', '确认'] },
  { name: 'er', source: 'erDiagram\nPROJECT ||--o{ TASK : contains', labels: ['PROJECT', 'TASK', 'contains'] },
  { name: 'gantt', source: 'gantt\ntitle 交付\ndateFormat YYYY-MM-DD\nsection 阶段\n测试 :a, 2026-11-05, 2d', labels: ['交付', '测试'] },
  { name: 'journey', source: 'journey\ntitle 阅读\nsection 阶段\n  确认: 5: 管理员', labels: ['阅读', '确认'] },
  { name: 'pie', source: 'pie title 任务状态\n  "待办" : 12\n  "完成" : 24', labels: ['任务状态', '待办', '完成'] },
  { name: 'quadrant', source: 'quadrantChart\ntitle 优先级\nx-axis Low --> High\ny-axis Low --> High\n重点: [0.8, 0.3]', labels: ['优先级', '重点'] },
  { name: 'requirement', source: 'requirementDiagram\nrequirement deletion {\n id: PD1\n text: "检查权限"\n risk: low\n verifymethod: test\n}\nelement web {\n type: client\n}\nweb - satisfies -> deletion', labels: ['PD1', '检查权限', 'web'] },
  { name: 'xy', source: 'xychart\ntitle "趋势"\nx-axis [Mon, Tue, Wed]\ny-axis "完成" 0 --> 20\nbar [3, 5, 8]', labels: ['趋势', 'Mon', 'Wed'] },
  { name: 'block', source: 'block\ncolumns 2\nA["客户端"] B["数据库"]\nA --> B', labels: ['客户端', '数据库'] },
  { name: 'packet', source: 'packet\n0-7: "版本"\n8-15: "类型"', labels: ['版本', '类型'] },
  { name: 'kanban', source: 'kanban\n  todo[待办]\n    req[检查权限]\n  done[完成]\n    result[确认]', labels: ['待办', '检查权限', '完成'] },
  { name: 'eventmodeling', source: 'eventmodeling\n\ntf 01 ui DeleteProjectUI\ntf 02 cmd DeleteProject\ntf 03 evt ProjectDeleted', labels: ['DeleteProjectUI', 'DeleteProject', 'ProjectDeleted'] },
] as const;
