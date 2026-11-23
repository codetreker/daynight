# Agent Note: Assistant task decisions in the assistant workspace

Status: implemented

## Problem

Users need to inspect account-owned assistant work and decide manual revisions
without confusing it with scheduled project Tasks. Background refreshes and
navigation can outlive a user's edit or a dispatched write. Substituting newer
versions or forgetting the original operation would permit stale edits or
repeat creation without an informed decision.

## Decision

The assistant workspace provides an independent task list and routed detail with
manuals, appendices, proposals, history and grouped records. Existing Session
presentation slots hold a bounded pending strip, while the Session cache retains
conversation state. The [design](../../../../docs/design/assistant-task.md#网站)
owns routes, resource reads and write recovery.

Explicit editing and confirmation interactions retain their observed task
version. Account-scoped observable mutation state survives route changes and
publishes late unknown results to the current view. Creation preserves the
original request before dispatch in account-keyed session storage, with an
in-memory fallback. Reads of current facts never identify an uncertain write as
their cause. The browser does not act as a Bot or hold claim credentials.

Pending escalations follow the current task holder, unfinished items and event
expiry, independently of notification read markers or the historical delivery
target. Transferring responsibility must not hide an unresolved decision from
both assistants. Their links open the corresponding event; proposal
evidence links open records, including records beyond the first page.

Application-defined JSON retains numeric source tokens when JavaScript numbers
cannot reproduce them exactly. Dedicated parsing and serialization preserve
these values through reads, display, edited decisions and unknown-result
snapshots. Protocol counters and identifiers retain their stricter validation.
An omitted proposal rule set remains omitted in a body-only edited decision,
so the server can preserve the current rules rather than reject explicit null.

## Alternatives

**Place decision controls inside generated chat messages.** Provider timelines
are owned by their Session implementation and may be reconstructed from native
history. Routed resources and a composer slot give decisions stable identity
without making generated Markdown authoritative UI state.

**Use each latest polled version when saving.** That lets an old draft overwrite
someone else's intervening edit. Keeping the original version costs an explicit
reconciliation after a conflict but preserves the user's actual decision.

**Create Watchdog through the generic task API.** That would duplicate the
application's initial manual and falsely imply application availability. The
frontend uses a dedicated preset contract and reports unavailable servers;
application integration remains separately verifiable.

**Decode application JSON with ordinary JavaScript numbers.** This would round
large external identities or long decimals before the user sees or resubmits
them. Rejecting those values would instead make valid task materials unavailable.
Preserving numeric tokens keeps the server's application JSON contract while
requiring its consumers to use the dedicated serializer.

Appendix deletion clears references to an explicit empty slice in the core
candidate. A nil slice reaches the PostgreSQL JSONB parameter as SQL NULL and
violates the required reference field. Real database and API readback tests own
this persistence guarantee; a core mock alone cannot establish deletion.

## Consequences

Users can review and operate assistant tasks at desktop and phone widths without
changing project task scheduling. Independent API parsing, component state and
controlled browser tests have separate responsibilities; real localhost checks
establish persistence against the current service. The preset contract still
requires the Watchdog application endpoint and runtime before end-to-end
monitoring can be established. Session storage failure limits creation recovery
to the current application lifetime. Whole-list material polling trades bounded
implementation complexity for additional reads as history grows; records keep
explicit paging.
