# Autopilot

Enter this mode only when the user explicitly requests automatic execution of
Daynight tasks. Use the confirmed Goal or work scope. Loading the skill, a ready
task, or a completed `run-task` does not activate autopilot. A bare
`using-daynight` invocation can resume it only when the conversation establishes
that the user already activated it.

Read [the handbook](handbook.md) for discovery and query semantics. For a Goal
chain, read [the Goal protocol](goal.md) for stage requirements, breakdown, and
whole-Goal acceptance. Delegate execution and completion to
[run-task](run-task.md); do not maintain a separate delivery lifecycle here.

## Worker-managed assignment

A controller-supplied worker-managed assignment uses
[run-task's bounded assignment rules](run-task.md#worker-managed-assignment)
before this mode's restoration or selection. Execute only that supplied task
and claim, then return on completion or external wait. Do not select a successor
or advance a Goal stage, even when this session or an outer controller has
autopilot active.

## Restore the current target

Resume this session's current task before selecting new work. Read its ID from
the conversation or existing execution checkpoint, then refresh it with
`daynight task show <task-id> --json`. If identity is unknown, query
`daynight task list --status in_progress --json` as needed and establish which
task belongs to the current work. An arbitrary `in_progress` task is not
this session's target.

A waiting checkpoint retains its task until that task is confirmed done or the
user explicitly changes the target. Resume the required next action when
possible. Do not select another task because CI, review, or merge is pending.

## Select one related task

When the user explicitly supplies a task or fixed Goal queue, inspect its next
unfinished task by ID and use the manual execution path regardless of
`allowAgents` or platform compatibility. Preserve readiness, stage inputs, and
the existing execution scope; a fixed queue does not authorize unrelated discovery.
Existing scoped authorization covers its ready successors without per-task reauthorization.

Otherwise, when there is no current task, identify the actual runtime in the
environment where task commands and implementation will execute:

```bash
node -p "process.platform"
```

Map `win32` to `windows`, `darwin` to `macos`, and `linux` to `linux`.
A Linux runtime in WSL is `linux`, regardless of its outer Windows host.
Unsupported or unknown runtime platforms leave selection waiting with the concrete
reason. Do not substitute a configured platform, remote host OS, or requested task
platform for the observed runtime. Query platform-compatible candidates:

```bash
daynight task ready --allow-agents true --compatible-platform <actual-platform> --json
```

Pick exactly one ready `todo` task with `allowAgents=true` and `requiredPlatform`
either null or equal to the actual platform, most relevant to the confirmed Goal
and authorized work. Compare actions, scope, deliverables, solution, acceptance
criteria and actual dependencies; creation order does not establish relevance.
Read full details and actual task-specific and shared inputs for plausible
candidates under [the task content standard](task-content.md). Satisfy the same
six requirements whether content is inline, referenced, or mixed, and identify
the task-owned evidence location; permission true is not a permanent review
certificate. Reassess changed required sources before execution. Inspect complete
`dependsOn` and its `externalDependsOn` subset.
External prerequisites still block readiness, and cross-chain classification does
not authorize executing them or expand the confirmed scope. Readiness checks all
prerequisites, not stage artifact completeness or execution authorization.

Pass the selected ID, automatic-selection mode and actual platform to `run-task`.
Immediately before setting in_progress, reread the full task with
`daynight task show <task-id> --json` and recheck `todo`, ready, `allowAgents=true`,
and `requiredPlatform` either null or equal to the same actual platform. A changed
or incompatible requirement prevents starting and requires a new selection decision;
a changed execution environment requires fresh runtime identification and candidate
queries. Run-task enters in_progress using the version observed for that decision
before starting, using the exact version from this full-task recheck with
`--if-version`. An earlier compatible page does not authorize bypassing changed
eligibility. Autopilot cannot supply user confirmation of requirements or solution;
an explicit discussion-start request uses the Goal protocol's scoped manual path.

Ready returns at most 10 candidates by default or the requested bounded `--limit`;
it is not a complete backlog. Supplement an empty or unmatched page only with
needed selected reads, the graph, or
`daynight task list --allow-agents true --compatible-platform <actual-platform> --json`.
Both ready and supplemental list queries retain the actual-platform filter before
pagination and permission=true; do not filter a bounded unfiltered page locally.
Distinguish completed scope, missing execution authorization, prerequisite blockers,
other ongoing work and insufficient candidates. Do not take unrelated work to stay
busy or report completion from an empty or unrelated bounded page.

Autopilot permission alone covers execution of existing tasks, not creation of
new ones. Explicit user or repository tracking/review requirements supply standing
creation permission within the confirmed scope. Use existing creation permission
or obtain it before [create-task](create-task.md). Goal permission covers discussion
stages and the confirmed breakdown at user-confirmation gates; do not precreate
architecture placeholders or delivery tasks. Delivery registration leaves todo
without execution; complete solution discussion only after accepted material and
the real breakdown are verified. Existing explicit execution scope continues to
cover its ready successors without another per-task authorization.

Automatic selection never enables `allowAgents`; explicit
[handoff](handoff.md) is a separate review and permission operation that does not
activate this mode. An explicitly selected task or
fixed Goal queue's manual execution path remains available regardless of the flag
or platform compatibility; preserve prerequisite, stage-input and authorization
checks. An automatically selected ID passed to run-task remains automatic
selection and does not acquire this manual exception.

## Advance serially and accept the scope

Run one task at a time. Subagents collaborate on it; they do not each choose a
separate task. Ordinary CI, review, and merge waits keep that target. After
`run-task` confirms `done`, refresh readiness and select at most one next related
task within the same authorized scope. For Goal discussions, stop at each user
confirmation gate; completing requirements and starting solution discussion
requires the user's explicit confirmation and direction under the Goal protocol.
Solution confirmation permits todo delivery registration. Later delivery selection
requires a ready todo with complete inputs, explicit autopilot activation, and
execution authorization. Discussion completion satisfies a dependency and grants
no delivery execution permission. Existing scoped execution authorization
continues to apply to its stated ready successors.

If `run-task` returns a wait requiring external intervention, preserve its
current-task checkpoint and report the blocker and required next action. An
explicit no-merge or user-review requirement on a delivery task is such a wait; it never permits
auto-merge or marking the task done. An unfinished external prerequisite outside
the authorized scope is also an external blocker: preserve its ID and reason,
without dropping or reclassifying it to manufacture readiness. Return without replacing the target.

Before reporting a Goal complete, apply the Goal protocol's whole-Goal acceptance:
verify the full registered scope, every delivery task's completion, all necessary
PR merges, and the original overall acceptance evidence. A completed description
or design is only a stage result. For other scopes, verify their confirmed
completion conditions against the actual work.

Stop when the confirmed scope is complete, the user requests a stop, or progress
needs external intervention. Report observed results, remaining blockers, and
the checkpoint. Automatic task selection does not expand permission to merge,
deploy, communicate externally, or push mainline.
