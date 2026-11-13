# Agent Note: Proposed tasks without a mandatory approval stage

Status: implemented

## Problem

An externally suggested task may record work that has not been confirmed for the
execution queue. Treating every new suggestion as todo obscures that distinction,
while internal multi-step work may already have the confirmation it needs when
registered. Both kinds of work need normal task materials, dependencies and
visibility without making registration start execution.

The archived [three-state decision](../../archived/architecture/2026-10-24-task-status-assignment.md)
removed approval actions and migrated proposed rows to todo. Its original
migration remains historical fact. A new task state can distinguish current
suggestions without recreating that former approval workflow.

## Decision

Task has proposed, todo, in_progress, done and cancelled states. Creation defaults
to proposed and accepts explicit proposed or todo; confirmed internal multi-step
tasks can be registered directly as todo. Callers choose when to use proposed.
Ordinary status setting permits direct changes among proposed, todo, in_progress
and done, subject to the existing dependency, successor and Worker protections.
No approval command or mandatory proposed-to-todo transition is introduced.

Proposed is unfinished and nonterminal. It is not ready, cannot satisfy a
prerequisite, and cannot be acquired automatically even when allowAgents is true.
Explicitly authorized ordinary work can start directly from proposed once all
prerequisites and inputs are satisfied. Returning to proposed clears the current
execution endpoints as returning to todo does. Same-state requests preserve all
fields after exact-version validation.

The existing [cancellation decision](2026-11-06-task-cancellation-terminal.md)
continues to own the irreversible cancelled outcome and readable retained data.
Active claims still require controlled release. The [release decision](../simplification/2026-11-12-release-clears-ownership.md) clears current ownership so ordinary status rules apply afterwards.

A new migration expands the status constraint and changes the default without
altering existing rows, versions, timestamps or materials. Historical migrations,
including the original proposed-to-todo conversion, remain unchanged. Protocol
readers, graph summaries, filters and progress explicitly recognize proposed.
All-proposed ordinary components aggregate as proposed; unstarted proposed/todo
mixtures aggregate as todo. Only done/cancelled contribute to the ended count;
the [completion-progress decision](../bug-fix/2026-11-13-completion-progress-excludes-cancelled.md)
separately excludes cancelled from completion presentation.

The [status requirements](../../../../docs/spec/daynight-task-status.md) and
[architecture](../../../../docs/design/daynight-task-status.md) own the complete
current contract.

## Alternatives

**Keep todo as the creation default and require explicit proposed.** This keeps
existing callers in the confirmed queue but requires each external producer to
remember to mark unconfirmed suggestions. Default proposed makes that initial
meaning explicit while confirmed internal producers select todo.

**Require proposed to pass through todo before execution or completion.** This
could enforce a separate confirmation stage, but would impose workflow policy on
all callers and add a transition even when execution or completion is already
explicitly authorized. The status represents caller-managed meaning without
changing the existing execution safeguards.

## Consequences

Existing producers that mean confirmed work must explicitly choose todo. Generic
new tasks remain visible as unfinished suggestions while staying outside the
automatic ready queue. The creation default does not change existing task rows.

Adding a state requires coordinated service, MCP, CLI and Web readers. Graph
summary includes a distinct proposed count; treating every residual state as
cancelled would corrupt progress. Task Step states remain independent and do not
acquire proposed.
