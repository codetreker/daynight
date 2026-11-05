# Agent Note: Codex Interrupted Timeline

Status: implemented

## Problem

An interrupted Codex turn returned the Session to Ready without recording a
visible terminal result. Early interruption could also leave no user message:
the native runtime can end a turn before persisting its input. Reading only
native items cannot recover that empty turn or explain why it has no response.

## Decision

Project a confirmed native `interrupted` turn as `turn_interrupted`, using a
stable ID derived from its native thread and turn. Reuse the existing neutral
terminal presentation and timeline deduplication. An interrupt request or ACK
alone does not establish interruption; completed and failed turns retain their
existing meaning.

Load turn metadata through paginated `thread/turns/list` and contents through
turn-filtered `thread/items/list` so empty interrupted turns and their ordering
survive recovery without loading an entire long turn into one RPC frame. Only an explicit
method-not-found response permits the old items-only fallback. That fallback
cannot infer terminal status absent from its source.

Retain unobserved submitted text for the active turn as presentation evidence.
On interruption, recover native user items supplied with completion, then show
any remaining input with an explicit Controller provenance label. If dispatch
is still pending, defer those rows until its outcome settles so an explicit
rejection cannot become durable user history. Accepted and unknown outcomes
retain distinct wording, with input before the interruption marker; native turn
settlement remains independent. Closing the provider settles pending transport
requests and joins terminal projections before returning so an acknowledged
interruption survives immediate shutdown and archival. Missing native
items are reconciled against full turn history without delaying native turn
settlement. A matching native client ID can replace the temporary presentation
using its turn and client IDs; a read-only journal lookup retains that mapping
across Controller generations without changing ordinary native item identities.
Local text does not invoke receipt observation or
permit replay. Pure native recovery cannot reconstruct text that was never
recorded and instead shows a missing-input diagnostic.

The [Session design](../../../../docs/design/task-session-protocol.md#codex-中断与缺失输入)
owns the runtime behavior and its preservation limits.

## Alternatives

**Emit only when the user clicks Interrupt.** A racing normal completion or a
failed interrupt request would then be mislabeled. Native turn status supplies
the actual result independently of request timing.

**Rely on individual user-message notifications and items-only recovery.**
Codex can emit neither for an early interrupted turn. The turn record is the
only surviving evidence of interruption in that case.

**Wait for a complete history lookup before settling the turn.** History reads
can fail or be delayed. Making cancellation confirmation depend on them would
change the existing control lifecycle merely to improve timeline presentation.

**Treat a local echo as native receipt evidence.** The Controller knows what it
submitted, not whether the native conversation recorded or consumed it. Using
that text to reconcile an unknown operation would erase a meaningful boundary.

## Consequences

Users can distinguish an interrupted turn from silence, including after native
resume. Stable marker identities avoid duplicate rows on repeated observations.
Early missing inputs remain readable when the Controller owns their text, with
explicit provenance and no new input replay path.

Native history and Controller-retained presentation remain different sources.
A new Test Session restored solely from native history cannot recover unrecorded
text. Existing archives are immutable. Older app servers without turn listing
retain items-only recovery and cannot supply missing terminal state.
