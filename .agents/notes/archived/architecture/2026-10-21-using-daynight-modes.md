# Agent Note: One public skill with explicit task modes

Status: implemented

## Problem

A task-management skill combines reference material, work registration, execution
and continuous scheduling. Loading it for a command question can therefore be
mistaken for authorization to start tasks or continue through a backlog. Keeping
plans, acceptance and progress together in task descriptions also makes stable
requirements harder to distinguish from the current execution position. Serial
execution alone leaves discussion scope ambiguous: a designated subtask can still
absorb proposals for its parent Goal, siblings or successors without changing its
task ID. Registering every transitive prerequisite as a direct edge also obscures
the immediate work order without adding a prerequisite; reducing those edges
without considering their ordinary or external classification can change chain
ownership.

## Decision

The [Goal workflow decision](../../implemented/process/2026-10-22-goal-workflow-design.md)
partially supersedes the original registration and task-content rules. It owns
stage-specific inputs, self-contained task briefs, shared-input ownership and
whole-Goal completion. Mode routing, command ownership, authorization and the
installer decisions remain here.
The later [user-confirmed Goal discussion decision](../../implemented/process/2026-10-24-user-confirmed-goal-discussions.md)
owns sequential discussion creation, explicit user transition gates, and scoped
starting the specified discussion. The [task-content and handoff decision](../../implemented/process/2026-10-25-task-content-handoff.md)
replaces mandatory primary-attachment ownership with one content owner and adds
a separately authorized handoff mode. The [managed execution decision](../../implemented/architecture/2026-10-26-managed-task-skill.md)
replaces the continuous-scheduling mode and the placement of managed rules while
preserving the single public bundle and shared authorization boundaries. This
note retains the rationale for those earlier choices.

The public bundle is named `using-daynight`. Its entrypoint routes ordinary
requests to handbook, create-task, handoff or run-task. Only a worker startup
prompt that explicitly supplies the worker-managed environment, using-daynight
skill and execute-task-in-managed mode selects the managed execution reference.
The entrypoint keeps this distinction brief; ordinary references do not load
managed lifecycle instructions. A bare ordinary invocation uses context;
insufficient or ambiguous context prompts for intent. The original autopilot
mode required an explicit continuous-execution request to avoid converting
ordinary skill use into scheduling. The managed execution decision removes
that mode and leaves continuous scheduling with the worker. The handbook
provides a command-purpose index and
operational context such as repository discovery, read scope, observed-version
updates and attachment independence. Installed CLI help owns argument and option
usage; the handbook does not duplicate invocation examples or decoding code.
Task lists traverse matching pages but exclude completed work by default;
complete inventories and prior-registration checks explicitly include completed
tasks. Status/readiness grouping does not establish relevance. Human lists are
summaries; JSON lists omit only description, as owned by the
[JSON description decision](../../implemented/simplification/2026-10-22-task-list-json-description.md).
Ready, details and write results retain full task resources, and consumers read
details when they need a description.

This partially replaces the
[original public distribution decision](2026-10-21-public-agent-skill-design.md):
portable packaged files, the interactive Agent/scope flow and complete replacement
remain, while the public name and workflow ownership change. The
[bounded-selection decision](../feature/2026-10-21-bounded-ready-task-selection.md)
continues to own query cost and candidate semantics. Run-task owns one specified
task's ordinary lifecycle; execute-task-in-managed owns its assigned claim's
lifecycle. The neutral task-execution reference owns their common inputs,
delivery, evidence and completion readiness.

The original creation rule required explicit user permission for every task to
keep the persistent backlog under the user's control. A direct creation request
or existing scoped permission avoided repeated confirmation; implementation
requests, inferred routing, tracking needs and autopilot activation alone supplied
none. The later [mandatory tracking and review decision](../../implemented/process/2026-10-24-daynight-tracking-and-design-review.md)
recognizes an explicit user or applicable repository tracking/review instruction
as standing permission for necessary tasks within the confirmed scope. Missing
permission still requires asking, and approval, execution and delivery remain
separate.

The original registration flow skipped one-off and trivial work to avoid treating
execution steps as tasks. The [tracking and review decision](../../implemented/process/2026-10-24-daynight-tracking-and-design-review.md)
now defines eligibility by concrete outcomes, keeping agent-generated execution
steps in the owning task's plan. Create-task checks creation permission, matches
existing problem/scope and acceptance, and registers ordinary single-outcome work
or a staged Goal. Every description identifies its task, responsibility and readable
sources. The shared task-content standard requires objective and requirements,
scope and deliverables, solution and design, input/output contracts, acceptance
and verification, and references. Direct descriptions, referenced documents and
mixed organization meet the same content-sufficiency requirement. Description-relative links and images start at
the current task's attachment root; attachment Markdown retains its document
directory. Uploaded contents are confirmed before linking, and full-field updates
preserve Markdown and valid references. The create-task reference owns authoring
examples; no new stored format or format flag is introduced. Each content item has
one owner, and the task designates its own description or attachment location for
confirmation, acceptance conclusions and evidence. A complete description does not
require a primary attachment. Shared Goal
and design inputs remain with their owners. Each Goal delivery description
directly identifies its architecture task and every required source, even for
indirect successors. Shared body content names the owning task ID, description
field (whole body or applicable sections) and is read with task show; actual attachments use
full paths. Repository documents retain the architecture task identity and a
verified immutable URL. Complete inline architecture requires no fabricated path
or duplicate attachment. Registration verifies every source index,
and execution reads the listed inputs before implementation;
registration does not copy the same document packet to every task. Independently
required snapshots retain source version and purpose.

The original mode decision required complete solution and applicable frontend
prototype before registration. That rule made ordinary implementation inputs
explicit, but cannot apply to stages producing those artifacts. The Goal
protocol originally registered `[Goal]<outcome>` and its dependent architecture
placeholder with stage briefs. Its successor creates only requirements discussion
first, starts solution discussion after user-confirmed requirements and an explicit
transition request, and registers delivery tasks only after user-confirmed design.
Clarification still produces complete requirements and applicable final-style
interactive frontend-only UI. Implementation roots depend on design.
Scoped Goal creation permission covers necessary stages and the confirmed breakdown
at those respective gates.
The Goal protocol adds no service resource, CLI command or ownership mechanism.
The [status assignment decision](../../implemented/architecture/2026-10-24-task-status-assignment.md) applies
to every stage: registration produces todo without execution. Ready work within
the existing execution scope starts with observed-version set-status in_progress
and finishes only after acceptance and required delivery. Existing authorization
can cover several designated tasks, but single-task execution returns after the
specified task and does not select a successor. Explicit discussion starts apply
only to the current user-confirmed Goal stage.

A worker startup prompt explicitly selects execute-task-in-managed and supplies
the original assignment. The [managed execution decision](../../implemented/architecture/2026-10-26-managed-task-skill.md)
owns that entrypoint and its isolated lifecycle; the
[worker-managed completion decision](../../implemented/architecture/2026-10-26-worker-managed-completion.md)
owns the public claim-bound completion operation. The assigned agent preserves
the original claim, frozen configuration and supplied worktree, satisfies all
delivery gates, and finishes with that claim ID. The controller owns successor
selection and system-worktree cleanup. Task properties, cwd or environment
variables alone cannot activate the mode.

Necessary direct dependencies remain in dependsOn, with externalDependsOn as
its explicit external subset. The handbook owns dependency reduction: creation
and Goal registration omit direct edges already supplied by other retained paths
and verify necessary paths and absence of redundancy on readback. Ordinary edges
require an alternative path made entirely of ordinary edges, preserving chain
ownership and the Goal's ordinary design gate; external edges may be supplied by
either kind. Independent prerequisites and retained edge classifications remain.
Direct architecture source references do not require extra execution edges. The
rule constrains registration within its authorized scope and does not add server
normalization or authorize unrelated existing-graph cleanup. PR URLs and titles
remain in properties.pullRequests. Results and merge references belong at the task's
designated evidence location, associated with its acceptance items. Execution position, blockers and next steps use
an existing checkpoint. Registration is complete only after necessary task-owned
artifacts and shared inputs are read back. Partial registration retains IDs;
uncertain writes are reconciled before further mutation. Registration leaves
todo without starting execution. Run-task reads the self-contained brief, detailed
plan and stage inputs, establishes the task's confirmed scope and acceptance before
analysis, questions or proposals, executes its designated task and returns after
completion or an external blocker. The entrypoint's shared constraints own the
complete execution and discussion scope rule; the common task-execution
reference links to that rule before analysis and execution. Analysis, questions,
proposals, discussions and subagent work
follow the current task's confirmed objective, scope, deliverables and acceptance.
Parent Goal, shared architecture, sibling and successor material supplies required
inputs, interfaces and constraints without expanding the assignment. Cross-task
blockers and follow-up proposals retain the existing creation and execution
permission requirements. Expanding the current task's scope requires explicit user
confirmation. A Goal discussion or final-acceptance task covers the whole Goal
when that is its confirmed scope.

Development and PR-delivered documentation
require every necessary PR platform-confirmed merged and acceptance satisfied
before versioned task set-status done. Retaining a delivery PR keeps its task in progress;
completion grants no merge authority. Goal discussions instead follow user-confirmed
material and their phase acceptance. An explicitly requested discussion transition
can start the next discussion without continuous queue selection. A stage done
does not establish whole-Goal completion.

The original autopilot workflow restored the checkpoint's current task and
selected one related ready task only after confirmed completion, with
allowAgents=true required for automatic discovery. That policy kept waits and
subagents on the current task and distinguished explicit task queues from
automatic discovery. The managed execution decision removes this agent-side
scheduling loop. Ordinary run-task retains its designated task through waits
and returns after completion or an external blocker; the worker owns managed
successor scheduling. In-progress inventory still does not establish ownership,
and a bounded ready page does not establish complete backlog state.

The installer publishes the complete using-daynight bundle before removing the
legacy daynight leaf in the same selected physical skill root. Other scopes,
other roots and unrelated skills remain unchanged. Parent aliases are preserved;
leaf links are replaced or removed without following them. Planning rejects
installation or legacy-cleanup paths that could delete another selected target.
Legacy cleanup failure preserves the new bundle and reports partial migration
with a nonzero result. Successful destinations and unattempted targets remain
explicit. Existing replacement, cancellation and native terminal guarantees hold.

The [requirements](../../../../docs/spec/daynight-agent-skill.md) and
[design](../../../../docs/design/daynight-agent-skill.md) own the full current
contract. This work consumes the adopted attachment capability; it does not add
attachment APIs, storage or commands.

## Alternatives

**Three public skills for usage, autopilot and execution.** This separates
triggers, but creates several discoverable entrypoints and duplicates common
rules or requires cross-skill installation. A single bundle with internal modes
keeps installation, versioning and command reference ownership together.

**Keep one undifferentiated task-management flow.** This preserves the old name,
but does not distinguish a handbook request, registration, one-task execution
and a continuous queue. Explicit mode boundaries make starting and continuing
work depend on the actual user request.

**Default bare invocation to handbook.** This is predictable but discards clear
context such as a previously designated task or a current creation request.
Context-based routing preserves that intent; ambiguity is resolved with the user.
At the original decision, autopilot also had an explicit-request gate; the
managed execution decision removes that mode without changing ordinary routing.

**Put solution, acceptance and progress in the description.** This was convenient
before attachment-backed planning was available, but keeps unrelated lifetimes in
one field and encourages repeated copies. At the original decision, problem text, attached requirements, structured
dependencies and execution checkpoints received separate owners. The Goal decision then retained detailed attachment ownership while allowing a concise
assignment and completion summary in each description. The content/handoff successor
allows a complete description while retaining a single owner and separate operational
checkpoints, so the original risk of competing plans and progress logs remains avoided.

**Repeat the complete scope rule in every mode.** This makes each mode locally
explicit, but creates multiple copies whose exceptions and permission boundaries
can diverge. The entrypoint owns the shared rule, with a linked reminder where
run-task begins analysis and execution.

**Reduce dependencies using reachability alone.** An alternative path containing
external edges still supplies execution ordering, but cannot replace an ordinary
edge's chain ownership or ordinary design gate. Restricting ordinary reduction to
all-ordinary paths preserves those meanings while omitting redundant blocking
edges.

**Delete the legacy entry before publishing the new bundle.** This reduces the
period with two names but can remove working guidance before replacement succeeds.
Publishing first preserves the new bundle even if legacy cleanup fails, at the
cost of an explicit partial-migration error and a possible temporary duplicate.

## Consequences

One installed directory contains the entrypoint, ordinary mode references, the
managed execution reference, neutral task-execution guidance, task-content
standard and Goal protocol. Command usage stays with the installed CLI, and the
compact handbook explains the operational facts needed to choose and combine
commands. Ordinary and managed execution share delivery and acceptance
requirements while keeping their lifecycle operations separate. Explicit worker
mode routing keeps managed instructions out of ordinary execution; the removed
autopilot workflow no longer turns a skill invocation into a continuous queue.
Scoped task creation permission,
including applicable standing tracking/review instructions, prevents autonomous
execution from expanding the persistent backlog beyond the confirmed scope;
missing permission requires user input before registration. Required referenced content
becomes an execution input; a complete body needs no attachment. Create-task must
reconcile partial registration and cannot claim readiness from an existing task ID alone. A task's confirmed scope also bounds
its discussion content, while broader inputs remain readable and Goal-level
discussions and acceptance retain their agreed scope. Cross-task discoveries remain
visible without silently adding work to the current delivery. Dependency graphs
express immediate prerequisites without redundant transitive shortcuts, while ordinary
chain membership and design gates remain explicit. This requires reading the
relevant paths before registration and checking the retained graph afterward;
the service does not automatically normalize supplied relationships.

The instructions constrain agents but do not add a server lock or guarantee model
compliance. Static bundle checks and independent scenario review cover content;
packed native installer tests prove files and interactions. These remain separate
claims, as required by the
[installation acceptance decision](../testing/2026-10-21-simulated-agent-installation-acceptance.md).
Other-scope legacy copies may remain discoverable under host precedence and need
scope-appropriate installation. Automatic global migration, cross-target rollback
and live model acceptance are not implied by a successful installation.
