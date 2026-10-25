# Create a task

Use this mode to prepare and register work that needs persistent tracking. Read
[the handbook](handbook.md) before discovery, queries, or writes. Return after
registration; registration alone does not authorize execution or
autopilot. An explicit request to start a Goal discussion routes the registered
current stage to run-task under the Goal protocol.

Create tasks only with the user's explicit permission for the relevant scope.
An explicit user or applicable repository instruction requiring Daynight tracking
or review supplies standing creation permission for necessary tasks within the
confirmed scope. Reuse suitable tasks and do not ask for that permission again.
Loading this mode, needing durable tracking, or permission to implement or run
autopilot alone does not grant creation permission. Ask when it is missing; reuse
permission already granted for the scope. Creation does not authorize execution or delivery.

## Choose the tracked outcome

With creation permission, register or reuse a task for concrete work such as a
feature, bug fix, architecture/design assignment, or actual work item produced by
its breakdown. Each task has its own objective, scope, and observable completion
conditions. Solution, architecture, and design reviews use their owning task
under the entrypoint's required tracking and review rules.

Keep an agent's transient execution steps, such as reading files, running
commands, and routine checks, in the existing execution plan. Do not turn these
steps into Daynight tasks merely because an agent generated them. A distinct
acceptance or validation assignment with its own outcome can still be a task.
For [final acceptance](../SKILL.md#final-acceptance), identify the entire task or
Goal being assessed and its confirmed requirement sources. Define the deliverable
as the acceptance conclusion, evidence, defects, and unverified items. Apply the
shared rule to temporary helpers; do not make their development or repository
delivery the acceptance outcome.

Running a check while delivering an existing task is an execution step. If the
request contains only execution steps for existing work, keep them with that
work and return without registering additional tasks.

For a multi-stage Goal, follow [the Goal protocol](goal.md). Register only the
current requirements discussion task; do not create an architecture placeholder
or delivery tasks upfront. Its stage brief describes the discussion and its
user-confirmation gate; finished requirements and applicable prototypes are
outputs. User-confirmed requirements permit creation and start of solution
discussion. Only user-confirmed solution permits actual delivery registration.
A registration-only request leaves the current stage todo and returns; an
explicit discussion-start request authorizes its start through
run-task. Creating a Goal covers the later in-scope stages and breakdown only
at those confirmation gates.

For a single tracked outcome, prepare its solution, acceptance criteria, and
applicable mock UI before registration, following the artifact rules below.

Look for existing work with the same problem and scope, including completed
tasks; the default list contains only unfinished work. Inspect full descriptions,
actual dependencies, primary Markdown, and acceptance criteria. For a Goal,
inspect the existing chain and its owning inputs. Titles alone do not establish
identity. Reuse suitable work and preserve valid requirements; interrupted
registration does not justify a duplicate task or chain.

## Write task-specific content

Use the target repository's document and workspace rules.

| Content | Owner |
|---|---|
| Concrete problem, current actions and scope, deliverables, constraints, completion summary, and real input references | Task `description` |
| Detailed solution, full acceptance criteria, verification methods, and completion evidence | This task's primary Markdown attachment |
| Applicable visual and interaction design | Owning task's interactive mock UI and resources, referenced by consumers |
| Prerequisite tasks and edge classification | Complete `dependsOn` plus its `externalDependsOn` subset |
| Delivery PR URLs and titles | `properties.pullRequests` |

Give each task an outcome-focused title and a self-contained Markdown
description: a reader must understand what this specific task will do, deliver,
and verify without opening attachments. Summarize the approach and observable
completion conditions, then reference the real detailed sources. A generic
problem sentence and a link list are insufficient. Keep the summary consistent
with its primary Markdown without maintaining a second complete plan in the
description.

The primary Markdown must contain **Solution** and **Acceptance criteria**
sections; equivalent headings in the task's language are valid. Define the
current task's approach, scope, behavioral constraints, observable completion
conditions, and how to verify them. Stage briefs describe the work that will
produce that stage's results. They do not claim unfinished outputs already exist.
Link supporting resources from the primary document.

Attach only this task's detailed plan, needed resources, and outputs. Shared
Goal requirements stay with the Goal description task; architecture and
breakdown stay with the design task. Consumers identify the source task ID and
attachment path and confirm the contents using the installed CLI's attachment
read command. For repository inputs, use verified immutable references. Do not
assume a `task://` scheme, cross-task relative links, or a fixed service host.
For every Goal delivery task, list the architecture task ID and all required
architecture document references directly in its description, including indirect
successors. Use the Goal protocol's full attachment paths or immutable repository
references; keep these input references separate from execution dependencies.
Do not upload the same whole packet to every task. Create a separate snapshot
only when the task needs an independent copy, recording its purpose, original
source, and source revision or content identity.

A frontend delivery task requires an interactive mock UI that runs with frontend code
alone, matches final visual styling, and represents relevant data and interaction
states. Include applicable populated, empty, loading, failure, disabled, long
content, and narrow-screen cases. Provide required CSS, JavaScript, images, and
other resources with working relative references. A static sketch or simplified
styling does not satisfy this requirement. For a UI Goal, this prototype is
produced by the Goal description stage and referenced by later tasks.

Use established task IDs for real prerequisites. Confirmed same-chain stages
use `--depends-on`; a verified prerequisite owned by another same-project chain uses
`--external-depends-on`. The CLI sends their complete union and explicit external
subset. Do not infer ownership from status, title, graph roots or array order,
and do not add a dependency only to make tasks appear together. Resolve unclear
ownership before registering the relationship. A top-level task has no ordinary
prerequisites; it may still have real external prerequisites that block execution.
Do not add a Dependencies section or duplicate the relationship lists in task
prose. Repository specifications and design documents retain their full contracts;
the task's own primary attachment still provides its specific solution and
verifiable acceptance criteria.

## Author Markdown

Use headings, paragraphs, lists, quotes, fenced code, tables, links, and images
when they help readers understand the assignment. The Web renders CommonMark
and GFM; raw HTML appears as text. API and CLI reads retain the original Markdown
string, with no separate format field. Preserve its syntax, whitespace, code,
and valid references when replacing the complete description.

A relative link or image in a description starts at this task's attachment root.
A link inside a Markdown attachment starts at that file's directory. Keep paths
inside the task root and preserve the actual case and resource identity. Confirm
an upload and read back its contents before adding its link. Reference shared
inputs by their verified source task ID and attachment path or immutable
repository URL; a relative link cannot identify another task's attachment.

For example, the following brief applies to a task whose confirmed, readable
attachments include its own `plan.md` and the complete `mockui/index.html`
prototype with its resources. Use these paths only when those files actually
belong to that task; adapt the content and references to the actual assignment.
A Goal stage that produces a prototype links it only after producing and
confirming it.

```markdown
## 问题与行动
登录失败后，用户无法判断是否可以重试。实现明确的失败原因和重试入口，保留当前登录表单输入。

## 范围与交付
更新登录页的错误提示、重试交互和中英文文案；沿用现有认证接口与会话边界。

## 完成条件
网络失败和凭据错误均显示对应提示；重试成功后进入工作区。桌面与窄屏、两种语言的交互通过验证，表单输入保持正确。

## 资料

- [方案与验收](plan.md)
- [交互原型](mockui/index.html)
```

This remains a concise assignment. Its own primary Markdown still contains the
specific **Solution** and **Acceptance criteria**, verification methods, and
evidence. The prototype remains with its actual owner when shared across a Goal.

## Register and verify

New tasks have `allowAgents=false`; creation cannot enable the permission.
Automatic workers and agent workflows must not turn it on themselves. Execution
authorization and automatic-discovery permission remain separate decisions.

Tasks without `--required-platform` are unrestricted. Set windows, linux or macos
only when the confirmed task needs that execution environment. Platform requirements
do not start tasks or enable automatic execution; they survive all status changes.

Reuse the established project and suitable tasks. Create new tasks in `todo`,
retaining each confirmed ID. Set concrete descriptions and actual ordinary and
external prerequisites using the handbook's full CLI replacement rule. Upload each task's own primary Markdown and required
resources; add actual attachment references to the complete description using
the observed task version. Reference already readable shared inputs at their
source. Do not present planned uploads as existing attachments.

Read back each complete task, its attachment inventory and required contents,
and its referenced shared inputs. Verify self-contained Markdown descriptions,
valid links and images, the two required primary-document sections, real source
identities, complete prerequisites and their intended external subset, and applicable mock UI resources and
interaction. For a Goal, verify only the current discussion stage and its brief;
verify later stages and delivery tasks when their confirmation gate permits
registration. When registering delivery work, check every task's description,
including indirect successors, for its architecture task ID and required document
references, and read the referenced contents under the Goal protocol.
Registration is complete only when required artifacts and associations are
confirmed readable. Registration leaves work todo and does not execute it. A Goal
discussion-start request is scoped execution authorization for that discussion,
as the Goal protocol specifies. User solution confirmation permits registration
of todo delivery tasks and grants no delivery execution permission. Apply any
existing explicit execution authorization only within its stated task or Goal
scope; ready successors in an authorized fixed queue need no per-task authorization.

If creation succeeds but a later operation fails, retain the confirmed IDs and
resume missing operations there. Tasks remain `todo`. Reconcile uncertain results through the handbook before another
mutation. Report incomplete registration with the exact missing operation or
artifact and next step. Do not move detailed plans into descriptions to bypass
an attachment failure. Return after verified registration without selecting or
executing a task for registration-only requests. If the user explicitly requested
the current Goal discussion to start, pass its confirmed ID to run-task under
the Goal protocol.
