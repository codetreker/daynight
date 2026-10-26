# Agent Note: Explicit Worker-Managed Completion

Status: implemented

## Problem

The service can complete a protected worker claim, but a native agent using the
public task CLI previously had only the ordinary status setter. Reusing ordinary
skill execution can also start an already-claimed task again, replace its system
worktree, or select a successor while the controller still owns its lifecycle.

## Decision

`task set-status <task-id> done --claim-id <claim-id>` explicitly selects the
existing typed claim-completion operation. The CLI validates and canonicalizes
the supplied UUID before configuration or network access and rejects its use
with another target. Ordinary status setting remains unchanged when the option
is absent. Expected versions, confirmed-result rendering and no automatic write
retries remain shared with the existing command.

The canonical using-daynight skill recognizes an explicit controller assignment
containing project/task/claim identity, worktree/branch and frozen configuration.
It verifies the latest active in-progress claim and actual workspace before
business work; a worker record alone is not an assignment. Missing or mismatched
context waits without falling back to ordinary selection or starting.

The agent uses the provided execution, performs the complete authorized task,
records its evidence, and finally completes the same explicit claim at the
observed version. Required PR delivery and human gates still apply. A refused
or unknown result cannot fall back to the ordinary setter; reconciliation reads
only the original claim. The controller owns system-worktree cleanup and the
next assignment, including when an outer autopilot is active.

The [task status architecture](../../../../docs/design/daynight-task-status.md#cli-与工作流)
owns CLI dispatch. The canonical
[worker-managed rules](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/run-task.md#worker-managed-assignment)
own the agent workflow. This partially supersedes the completion-verifier
responsibility in the [worker design decision](2026-10-22-worker-design.md) and
adds a bounded execution case to the [mode decision](2026-10-21-using-daynight-modes.md).
It does not change the service's protected ownership or ordinary status rules.

## Alternatives

**Keep completion accessible only through the typed client.** A native agent
would need an ad hoc wrapper around authentication, version handling and output
parsing. A done-only option reuses the public CLI's established lifecycle.

**Infer the claim from the task or environment.** That hides whether the caller
was assigned that execution and could turn an ordinary request into completion
of another controller's claim. An explicit argument and verified handoff keep
intent visible without treating public claim IDs as credentials.

**Report success to the controller through a new command or result file.** That
adds another protocol and leaves completion interpretation in the runner. The
existing task status API already expresses the agent's final accepted result.

## Consequences

Worker-managed execution has a single task and explicit completion identity;
ordinary manual execution, Goal discussion and automatic selection retain their
own rules. Completion does not authorize a merge, deployment or broader work.
The skill is shipped from its canonical source; installed copies are not edited.
Static discovery and instruction-contract checks prove packaging, while a
controlled agent trace is separate behavior evidence. Neither substitutes for
later native Herdr or three-platform whole-Goal qualification.
