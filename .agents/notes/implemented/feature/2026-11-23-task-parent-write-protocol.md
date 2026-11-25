# Agent Note: Ordinary Task Parent Write Protocol

Status: implemented

## Problem

Clients need to create ordinary children and explicitly cancel an unfinished
subtree through the existing public Task tools. Default Goal navigation, scoped
write receipts and precommit response limits must remain usable by existing
clients. A false confirmation field must not bypass its target-type restriction.

## Decision

REST and MCP accept ordinary-parent creation and descendant-cancellation inputs
through their existing create and status operations. The
[parent write design](../../../../docs/design/daynight-task-parent-writes.md)
owns parsing, scope, typed-parent immutability, fault references and byte admission.
Cancellation retains field presence independently of its value, so both true and
false are restricted to ordinary cancelled requests before same-status handling.
Shared service transactions implement the lifecycle; protocol adapters do not
walk or mutate the subtree. This exposes the
[parent lifecycle decision](../architecture/2026-11-23-task-parent-lifecycle.md)
through public inputs without changing default read representations. The [Team policy](2026-11-25-team-nested-subtask-policy.md) now gates new deeper ordinary parent edges.

The CLI selects the extended relation view and exposes ordinary parent creation
and direct filtering separately from the existing Goal `--parent` option. Its
`--confirm` cancellation sends the explicit descendant flag with the supplied
or observed version in one status request; `--force` retains its Goal meaning.
Missing extended fields remain valid for older services, while rejected new
inputs are reported without replaying a weaker request.

## Alternatives

**Treat false as an omitted field.** This loses the request's explicit input and
allows a field that belongs only to ordinary cancellation on Goals or other
status operations.

**Introduce a separate cancellation tool.** Existing status tools already carry
exact versions, scope and write-outcome semantics; a separate tool would duplicate
those contracts without adding a business capability.

**Reuse the Goal parent option for ordinary Tasks.** Its established Goal and
`none` semantics would become ambiguous, including for existing scripts.

## Consequences

New clients can use ordinary parents while existing clients retain Goal-only
parent IDs. Extended representations count their actual UTF-8 bytes before
commit. Strict old services reject the new fields; callers must retain that
failure and must not silently resubmit a weaker cancellation. Module tests own
refusals and budgets; normal real-server flows prove REST/MCP assembly and
persisted readback.
