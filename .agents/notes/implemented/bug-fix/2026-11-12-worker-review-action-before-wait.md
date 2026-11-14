# Agent Note: Decide review actions before waiting

Status: implemented

## Problem

A background agent can know about an unresolved review concern while repeatedly
reporting that no new review arrived. Requiring continued waiting does not tell
it whether the next action is its own correction, an external response or a
missing user decision. Treating necessary authorization gaps as ordinary review
waiting also leaves no honest path to request the required decision.

## Decision

Startup, continuation and periodic Worker instructions require a complete current
review observation and a disposition, evidence and next actor for each concern.
Known unresolved feedback is actionable even when no new comment arrives. Agents
finish authorized corrections and responses before waiting; incomplete reads
retain uncertainty. Scope removal, separate delivery and public replies have
independent authorization. Existing authorization is reused.

The [autonomous execution decision](../feature/2026-11-11-worker-autonomous-execution.md)
originally narrowed intervention to severe design conflicts to prevent ordinary
execution choices from becoming pauses. That rationale remains. Its exclusive
threshold is superseded only for an evidenced lack of authorization for a
necessary action after other authorized work is complete. The original
versioned pause, assignment and resume checks remain in force. Normal CI and
review waiting still neither pauses the task nor ends the background turn.

The [delivery workflow](../../../skills/development-workflow/references/delivery.md#review-action-decision)
owns PR-specific handling and scenario validation. The [Worker specification](../../../../docs/spec/daynight-worker.md)
and [design](../../../../docs/design/daynight-worker.md) own prompt delivery.
Repeated unchanged polls do not produce equivalent chat updates; native Working
continues to mean turn activity rather than delivery progress.

## Alternatives

**Continue polling while any approval is missing.** This preserves persistence
but cannot distinguish external waiting from feedback the agent must handle.

**Pause whenever anything is unresolved.** This shifts ordinary corrections to
the user and repeats authorization requests despite feasible in-scope work.

**Infer a stall from chat text and intervene automatically.** Similar language
can describe legitimate waiting. A runtime classifier would need independent
evidence and action authority; this correction does not add one.

**Add a task waiting-state API and UI.** Structured waiting reasons could improve
visibility but cannot by themselves correct the agent's decision. They remain
separate product work; the native activity and input-eligibility contracts stay
unchanged so that future waiting information can coexist with them.

## Consequences

The same decision rules reach every assembled business prompt without requiring
repository skills at runtime. Prompt-delivery tests and controlled decision
scenarios provide different evidence; neither guarantees every model's behavior.
No scheduler, automatic intervention, PR mutation API or status color is added.
Existing frozen startup inputs and running native turns are not rewritten. New
rules require updated runtime inputs or an explicitly authorized intervention;
source validation is not evidence that a production Session changed behavior.
