# Codex cell 等待的恢复要求

## 问题与适用范围

Codex 0.169.0 的原生 `response_item/function_call` 使用 `wait` 等待
`functions.exec` 产生的 cell。已观察参数为
`{"cell_id":"3","yield_time_ms":1000,"max_tokens":18000}`。
将所有同名调用归为跨线程依赖，会阻止已完成轮次发布恢复点，使后续恢复进入
`outcome_unknown`。函数名本身不能区分 cell 等待与 agent 等待。

本要求适用于 [Bot 原生恢复点](../design/worker-bot-runtime.md#codex-原生恢复点)
的依赖分类。普通 Task/Test、UI、Provider 版本支持范围和旧 ticket 的行为不变。

## 分类要求

只有已验证的 cell wait 标识、原生调用类型及合法 JSON 对象参数可以获得例外。
参数必须包含非空字符串 `cell_id`，且只能包含受支持的可选等待参数。
可选参数的类型必须逐项验证；不能通过存在 `cell_id` 就放行混合参数。

真实 agent wait、包含 agent ID 的参数、混合参数、未知 wait 变体、损坏 JSON
或不支持的参数形状必须拒绝保护。`spawn_agent`、`send_input`、`resume_agent`、
`close_agent`、collab 事件和 session fork 继续拒绝。不能简单删除 wait 拒绝规则。

分类只检查真实 response item 及 compact 替换历史中的真实调用。
工具声明、工具返回的文本或无关 JSON 不构成跨线程依赖证据。
外部媒体的既有拒绝与内嵌图片的校验规则保持不变。

## 恢复与未知结果

合法 cell 等待结束且目标 turn 完整落盘后，恢复存储必须能够发布并验证恢复点。
正常重连保留原 Bot、Session、native thread 和已确认业务认领，不重复用户输入
或工具操作。恢复继续要求原 writer 停止证明、Controller 存储归属、摘要完整性
及 `protectedThroughTurn` 一致。

未完成轮次、未知操作结果或 `dirty` 状态不得因为 cell 分类例外而恢复旧点。
历史 `outcome_unknown` 不自动重放，不重写原 journal 或接管其他 writer。

## 验收

- 使用上述真实字段形状，经公开的 protect/prepare 流程验证成功发布、字节完整性、
  原线程身份及独立活动副本；证明修复前同一用例失败。
- 验证真实 agent wait、混合参数、未知变体、损坏 JSON、fork 和 collab 均继续拒绝，
  失败不替换已有恢复点，不清除 dirty 屏障。
- 验证 compact 替换历史中的 cell 等待与普通 response item 遵守同一分类。
- 使用新建的合成 Bot 和受支持运行时，执行带 cell 等待的有界工具操作，观察完成
  轮次后的恢复点，再正常重连并读取助手任务；记录原身份、认领和不重复执行的证据。
  不使用已有未知结果会话试验重放。

单元测试证明恢复存储规则；真实 Bot 复测独立证明 Provider 与业务读取流程。
一类证据不能替代另一类。
