# Create a task

Use this mode to prepare and register work that needs persistent tracking. Read
[the handbook](handbook.md) before discovery, queries, or writes and
[the task content standard](task-content.md) for content preparation. After
verified registration, apply the [shared creation-to-execution authorization
rule](../SKILL.md#shared-constraints). Registration alone does not authorize
execution; starting an authorized ordinary task uses run-task, and Goal discussion
starts retain their stage-confirmation gates.

Create tasks only with the user's explicit permission for the relevant scope.
An explicit user or applicable repository instruction requiring Daynight tracking
or review supplies standing creation permission for necessary tasks within the
confirmed scope. Reuse suitable tasks and do not ask for that permission again.
Loading this mode, needing durable tracking, or permission to implement alone
does not grant creation permission. Ask when it is missing; reuse
permission already granted for the scope. Creation does not authorize execution or delivery.

## Choose the tracked outcome

With creation permission, register or reuse a task for concrete work such as a
feature, bug fix, architecture/design assignment, or actual work item produced by
its breakdown. Each task has its own objective, scope, and observable completion
conditions. Solution, architecture, and design reviews use their owning task
under the entrypoint's required tracking and review rules.

Keep an agent's transient execution steps, such as reading files, running
commands, and routine checks, in the session's execution plan. Do not put these
steps in task descriptions or attachments or turn them into Daynight tasks
merely because an agent generated them. A distinct acceptance or validation
assignment with its own outcome can still be a task.
For [final acceptance](../SKILL.md#final-acceptance), identify the entire task or
Goal being assessed and its confirmed requirement sources. Define the deliverable
as the requirement-based acceptance conclusion, supporting observations, defects,
and unverified items. Apply the shared rule to temporary helpers; do not make
their development or repository
delivery the acceptance outcome.

Running a check while delivering an existing task is an execution step. If the
request contains only execution steps for existing work, keep them in that
work's session and return without registering additional tasks.

For a multi-stage Goal, follow [the Goal protocol](goal.md). Register only the
current requirements discussion task; do not create an architecture placeholder
or delivery tasks upfront. Its stage brief describes the discussion and its
user-confirmation gate; finished requirements and applicable prototypes are
outputs. User-confirmed requirements permit creation and start of solution
discussion. Only user-confirmed solution permits actual delivery registration.
A registration-only request leaves the current stage todo while awaiting the
explicit answer to the creation-to-execution question; an explicit
discussion-start request authorizes its start through run-task. Creating a Goal covers the later in-scope stages and breakdown only
at those confirmation gates.

For a single tracked outcome, prepare its stage-appropriate task definition,
actual required inputs, and acceptance criteria before registration. A frontend
delivery task also needs its applicable mock UI under the artifact rules below.
A design-producing task does not require its unfinished design as an input.

Look for existing work with the same problem and scope, including completed
tasks; the default list contains only unfinished work. Inspect full descriptions,
actual dependencies, content sources, and acceptance criteria. For a Goal,
inspect the existing chain and its owning inputs. Titles alone do not establish
identity. Reuse suitable work and preserve valid requirements; interrupted
registration does not justify a duplicate task or chain.

## Write task-specific content

Use the target repository's document and workspace rules and the shared task
content standard. Give each task an outcome-focused title and a Markdown
description that identifies its concrete work, responsibility, and actual content
sources. The description and readable references together provide its objective
and requirements, scope and constraints, inputs and sources, deliverables and
contracts, and acceptance criteria. Complete inline content needs no primary
attachment; reference-owned and mixed content are also valid without repeating
complete documents. Save results as they are produced. Stage briefs describe
work that produces the stage's outputs; do not claim unfinished outputs already
exist or require an execution plan, confirmation log, or evidence attachment.

Attach only resources this task needs or owns. Keep shared Goal requirements
with the requirements task and architecture and breakdown with the solution
task. Reference the owning task ID and its description with applicable sections
for inline content, full paths for actual attachments, or verified immutable
repository sources. Read source descriptions through `task show --json` and
attachment bytes through the attachment commands. For every Goal delivery task,
list the architecture task ID and all required architecture source locations
directly in its description, including indirect successors, as
[the Goal protocol](goal.md) requires. Do not copy the whole shared packet
into every task. An independently needed snapshot records its purpose, original
source, and source revision or content identity.

A frontend delivery task requires an interactive mock UI that runs with frontend code
alone, matches final visual styling, and represents relevant data and interaction
states. Include applicable populated, empty, loading, failure, disabled, long
content, and narrow-screen cases. Provide required CSS, JavaScript, images, and
other resources with working relative references. A static sketch or simplified
styling does not satisfy this requirement. For a UI Goal, this prototype is
produced by the Goal description stage and referenced by later tasks.

Use established task IDs for necessary direct prerequisites. Before registration,
apply [the handbook's dependency reduction rule](handbook.md#dependency-reduction)
to omit relationships already supplied by another retained path. Confirmed
same-chain stages use `--depends-on`; a verified prerequisite owned by another
same-project chain uses `--external-depends-on`. The CLI sends their complete
union and explicit external subset. Do not infer ownership from status, title,
graph roots or array order, and do not add a dependency only to make tasks appear
together. Resolve unclear
ownership before registering the relationship. A top-level task has no ordinary
prerequisites; it may still have real external prerequisites that block execution.
Do not add a Dependencies section or duplicate the relationship lists in task
prose. Repository specifications and design documents retain their full contracts;
the current task identifies its required design inputs and verifiable acceptance
criteria directly or through their actual owners.

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
inputs by their verified owning task ID and description/sections or actual
attachment path, or by an immutable repository URL. A relative link cannot
identify another task's content.

For example, the following brief applies to a task whose confirmed, readable
attachments include the complete `mockui/index.html` prototype and its resources.
Use this path only when those files actually belong to that task; adapt the
content and references to the actual assignment. A Goal stage that produces a
prototype links it only after producing and confirming it.

```markdown
## 问题与要求
登录失败后，用户无法判断是否可以重试。显示明确的失败原因和重试入口，保留当前登录表单输入。

## 范围与交付
交付登录页的错误提示、重试交互和中英文文案；沿用现有认证接口与会话边界。

## 输入
[交互原型](mockui/index.html) 定义相关视觉样式和交互状态；认证接口沿用仓库现有契约，无新增任务间交换。

## 完成条件
网络失败和凭据错误均显示对应提示；重试成功后进入工作区。桌面与窄屏、两种语言的交互正确，表单输入保持。
```

This example defines the task inline and references its actual prototype. Shared
design inputs retain their real owner under the source rules above. Neither the
brief nor an attachment needs the session's implementation steps, tool choices,
or review schedule. A filename such as `plan.md` does not determine whether its
contents belong to the task.

## Register and verify

New tasks have `allowAgents=false`; creation cannot enable the permission.
Creation and breakdown do not enable it. A separate, explicitly requested
[handoff](handoff.md) reviews each task before enabling permission. Execution
authorization and automatic-discovery permission remain separate decisions.

Tasks without `--required-platform` are unrestricted. Set windows, linux or macos
only when the confirmed task needs that execution environment. Platform requirements
do not start tasks or enable automatic execution; they survive all status changes.

Reuse the established project and suitable tasks. Create new tasks in `todo`,
retaining each confirmed ID. Set concrete descriptions and actual ordinary and
external prerequisites using the handbook's full CLI replacement rule. Upload
required task-owned resources when the content uses attachments; add actual
references to the complete description using the observed task version. Reference
already readable shared inputs at their source. Do not present planned uploads as existing attachments.

Read back each complete task, its attachment inventory and required contents,
and its referenced shared inputs. Verify self-contained Markdown descriptions,
valid links and images, the stage-appropriate task definition, produced results,
real source identities, complete necessary direct prerequisites
and their intended external subset, absence of redundant dependencies under the
handbook's reduction rule, and applicable mock UI resources and interaction. For a
Goal, verify only the current discussion stage and its brief;
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
scope. Registration does not select or start a later task.

If creation succeeds but a later operation fails, retain the confirmed IDs and
resume missing operations there. Tasks remain `todo`. Reconcile uncertain results through the handbook before another
mutation. Report incomplete registration with the exact missing operation or
artifact and next step. An unreadable required source is still a failure; do
not silently replace it with invented or weaker content.

After verified registration, report the confirmed task IDs and current statuses.
Apply the shared creation-to-execution authorization rule: without applicable
execution authorization, ask whether to start the identified task and wait for
an explicit answer, leaving it todo. An affirmative reply or existing explicit
authorization permits only its specified task and scope to proceed through
run-task once its prerequisites and required inputs are complete. An explicit
request to start the current Goal discussion follows the Goal protocol through
that same ordinary entry. Do not select another task or start later delivery work
from registration alone.
