# 助手启动前的角色与环境准备

## 职责划分

`packages/daynight/src/commands/worker/bots/instructions.ts` 是唯一角色模板拥有者。
`environment.ts` 提供普通目录中的 CLI 配置、身份和能力检查。二者供 Worker
托管消费者调用，不参与 Task coordinator，不创建任务或工作树，也不发送用户输入。
行为要求见[角色与环境规格](../spec/bot-role-environment.md)。

## 角色选择接口

`selectBotRole({serverRole, preparedRole})` 接收服务器当前角色与本地首次准备。
两项均须显式传入；`null` 表示读取成功且不存在，不能用于表示错误或未读取。
返回 `BotRoleConfiguration`，复用公开 Bot DTO 的
`{instructions: string, revision: string, digest: string}` 格式。返回值是不可变副本，
避免调用者之后修改持久化源对象而改变准备结果。

| 服务器值 | 本地值 | 结果 |
|---|---|---|
| 存在 | 不存在 | 校验并复用服务器原值，供本地重建 |
| 存在 | 完全相同 | 复用原值 |
| 存在 | 不同 | 报冲突，先核对原 registration |
| 不存在 | 存在 | 保留本地准备，供未知登记核对或首次提交 |
| 不存在 | 不存在 | 使用当前 `BOT_ROLE_REVISION` 和唯一模板生成 |

所有持久值检查字段集合、Unicode、非空白内容、NUL、UTF-8 字节数与摘要。
全文不插入服务地址、用户名、目录、token 或用户需求。revision 跟随模板修改，
digest 只计算角色全文的 UTF-8 字节，符合服务端登记契约。

托管消费者必须先将返回值持久化，再提交首次 register。登记响应未知时保留同一
registration 与角色；服务端冻结值存在后，每一代都复用其原文。纯 helper 无法
证明调用者已持久化或已权威读取，这些顺序由托管层验证。Controller ticket 与
Provider 传递沿用[共享角色机制](task-session-protocol.md#角色指令的共享传递)。

## 环境准备接口

`prepareBotEnvironment` 接收真实 `homeDirectory`、Bot `cwd`、目标 Worker 的
`workerPaths`（配置路径）、绑定 `serverOrigin`、`ownerUserId` 和取消 `signal`。
可显式提供继承 `environment`；缺省使用当前进程环境。返回准备后的
`environment`、alias `bindings`、可空 `aliasDirectory` 和 `release()`。

使用 `resolveConfigurationPaths` 检查 Worker 配置根与 config 文件的一致性，
验证 cwd 是本机可访问的绝对目录。读取该根中的正常 CLI 配置，先拒绝服务不一致
或无认证，再用已有 API client 查询当前用户，并检查响应 principal 与目标 owner。
不使用 Worker 缓存身份作为此次启动/恢复的认证证明。

复制继承环境并无条件设置 `DN_CONFIG_DIR`，剔除 Controller relay token 环境值。
`prepareAgentCliAliases` 继续解析真实目标并生成私有 shim；没有 alias 时 PATH
原样保留，有 alias 时只按现有规则前置目录。HOME、CODEX_HOME 和其他原生账户
目录不替换；Provider 的 native PATH 合并逻辑仍由其已有适配器负责。

在准备后的环境和 Bot cwd 下，通过现有有界子进程 runner 执行 project、task、bot、
worker 的 list/show `--help`，检查对应入口与 JSON 能力。此集合是启动前兼容性
检查，不是角色动作白名单。缺少能力、命令失败或取消不能报告准备成功。随后重读
服务认证和 alias 配置，检测准备期间变化；不承诺检测之后的配置不会改变。

成功后，消费者需在所有仍使用 shim 的后代停止后调用 `release()`。普通失败会
删除本次创建的 alias 目录；子进程清理结果未知时保留目录及清理失败类别，由
持有执行责任的消费者继续核实。不能在无法证明后代停止时删除其运行资源。

## 验证与边界

角色测试使用不同历史 revision、损坏值、内容冲突和准确字节边界验证选择结果。
环境测试使用隔离配置、受控身份响应和真实 CLI 帮助进程，验证配置根、普通 cwd、
PATH/alias、身份与错误分支，不读取用户实际凭据。测试不能证明 Provider 的
原生权限、模型遵循或 Bot 托管生命周期已组合完成。

本模块不锁住用户全局配置，也不缓存认证成功代替恢复时检查。CLI 能力发现仍由
真实 help 负责，业务权限由每次真实请求判定。设计取舍见
[准备机制决策](../../.agents/notes/implemented/architecture/2026-11-05-bot-role-environment.md)。
