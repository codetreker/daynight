# Worker 个人 prompt 设计

[接口需求](../spec/worker-prompts.md)拥有资源、权限、同步结果与错误合同；[决策记录](../../.agents/notes/implemented/feature/2026-11-09-worker-personal-prompts.md)保存选择和备选。

## 存储与单资源操作

`worker_prompts` 以 `(user_id,scope,scope_id)` 为主键，保存正文、正 int64 revision 和数据库更新时间。user scope 的 scope_id 是用户 ID；其余是项目或 Worker ID。没有行时生成虚拟版本 0；清空不删除行。首次创建依靠唯一键与条件插入，并发更新依靠完整 key 和 expected revision 条件；零命中为冲突，不自动重试。先比较版本再判断 no-op；no-op 在线性化读取时返回原资源，不修改时间。

读取在同一个只读 Repeatable Read 快照中检查外层权限并读取资源。项目写入在专用 Read Committed 事务内按 live Project、ownership、Team member、direct grant 的既有顺序取得授权共享锁并等待后复查，持锁至提交；正文 CAS 独立保护版本。Worker 身份按用户和 Worker 精确检查，不依赖近期窗口。只有确认提交才返回写入成功；提交未知和回滚错误保留内部错误链。

## Web 编辑与预览

`WorkerPromptEditor` 的 user、project 和 worker 三层共用同一编辑与预览结构。预览场景使用 [NativeSelect](native-select.md) 的 `filter`/`content` 变体，32px 高度按内容占位；公共组件拥有控件和箭头外观，页面仅安排预览区域与文本布局。原生 label、id、场景值及 `start`/`resume`/`ping` 选项保持对应；选择场景只更新示例预览，不保存正文、不发起请求，也不清除正文草稿。

Web 的三层编辑共用保存 owner。每次保存固定账户、目标、版本、操作身份和草稿代际；实际派发与完整校验的回执分别记录。身份暂停取消准备或在途请求，本地状态按未派发、未知或已确认结算，不等待远程准入。已确认资源由原 owner 持有可取消的发布工作，通过身份与项目权限检查后安装；销毁或替换 owner 会取消等待。暂停期间收到的撤权清理独立等待身份准入，恢复时复查撤权事实或原操作归属，不丢弃待发布回执。发布依据草稿代际保留之后的编辑，待发布回执不能作为再次写入的版本授权。

## 配置报告

HTTP 层在原报告调用前验证协议和有限 selector；service 先执行原 Worker 报告事务，确认提交后才以请求上下文派生最多五秒的只读快照。批次在同一快照中逐 key 检查权限和小型版本元数据；仅未知或不同版本读取正文。任一只读失败放弃批次结果并给每项安全错误，已确认的原生回执不变。失权是单项 `unavailable`，不泄露版本或正文。旧格式保持原结构，prompt 不进入持久化 Worker report、desired 或 observation。

完整报告 JSON 保持原 1 MiB 限额，selector 使用有界 header。最多三份正文以及原生配置的最坏 JSON 转义仍在协议 2 的 48 MiB 消费预算内；服务端不截断、不查询项目全集。快照结束后撤权不回收已经开始读取的字节；后续请求重新检查权限。

## Worker 同步与输入

Builtin 由编译进 CLI 的纯 builder 组装原 assignment 和运行约束，不读取公共手册或仓库流程文件。

Worker 在确认服务、用户和 Worker 身份后建立仅驻留内存的 source。每个实际需要输入的项目与公共 user、worker 层有各自版本、可用状态和代际。配置 reporter 复用原有 30 秒 timer、单飞请求和 pending，按每批最多三个 selector 有限地遍历当前需求；新需求有限优先，旧需求保持 FIFO。成功后仅补未服务项；网络、完整响应或批次失败终止本轮补齐，等待下一正常周期。重启从 null 版本重新同步，不写入原生配置或本地存储。

回执先验证身份与完整 JSON，再分别处理原生三字段和 prompt 子树。原生结果先应用项目选择，随后按捕获的代际接纳 prompt，避免移除项目的迟到响应恢复其值。`unchanged` 必须对应仍存在的已确认正文；`unavailable` 撤销可用性，临时错误保留最近成功值。同步停止并排空后清除内存。

输入在异步资源准备后同步捕获当前 tuple，纯函数追加完整 builtin、user、project、worker；已固定的投递正文继续由原有机制拥有。Herdr 和 Web 以显式等待结果保留真实资源观察；macOS 已完成首次输入的恢复使用独立恢复 builtin，不重放 assignment。独立 retry 需要新正文时使用同一个单次配置报告原语，没有新 timer 或编辑资源 GET。

原生边界分别复用完整 Herdr JSON-RPC 编码、macOS terminal paste 和 Web 完整 ticket 的纯校验。超限是明确未提交的等待，不改变恢复预算；按版本 tuple 和原生配置在内存中去重，变化后重新组合。Web 在身份资源准备完成后捕获正文，验证 raw prompt 和完整 ticket 后才固定 `initialPrompt` 并写入同一 ticket。

## 验证边界

`team-playwright.config.ts` 中的提示词浏览器回归验证 `WorkerPromptEditor` 的场景切换、正文草稿及后台复核连续性；prompt hook 模块测试验证保存和结果恢复。控件共同外观和原生行为由[公共选择组件](native-select.md#验证责任)的测试拥有。

core 单元验证正文、版本和状态转换；HTTP 和 service 验证身份先决条件、协议格式、原生提交与只读失败的独立结果。真实隔离 PostgreSQL 验证唯一创建、条件并发、授权锁与版本/正文同快照。一条真实 API 链路覆盖编辑、配置报告、unchanged 和清空。Worker 测试验证有限批次、代际与失败、输入组合和各原生路径的容量与等待；服务端确认下发不证明 Worker 已接收正文。
