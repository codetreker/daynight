# Agent Note: Current Session annotations in task chains

Status: implemented

## Problem

An in-progress task does not reveal whether its current Session is working,
waiting for a person, or idle. Opening every task to inspect its Session is
costly, especially when the chain is collapsed. Reusing an old claim or a stale
activity snapshot would misdirect that inspection.

## Decision

A page-owned summary store reads the authoritative current-session endpoint for
in-progress members of visible chains. It binds results to the authorized task
cache's claim, Worker, worktree, project and account. Child rows and chain heads
consume the same ephemeral summaries. The complete ordinary component membership
contributes to the aggregate even when children are collapsed or filtered.

The [design](../../../../docs/design/task-session-status.md) owns state precedence,
refresh and expiry limits, geometry and navigation. The store limits actual
unsettled requests, including cancelled transports. Identity changes remove the
old display before another result can publish. Failed reads hide the summary;
they do not manufacture a disconnected state.

Providers normalize pending interactions to waiting_input, so the current
snapshot supplies the necessary state without timeline reads. Explicit offline
or terminal lifecycle wins over retained activity. Session entry uses the
existing task Session route and its normal authorization checks.

## Alternatives

**Full Session clients per row.** These would load timelines and open channels
just to show a few words, increasing transport and retained history costs with
list size. The current endpoint already provides the necessary observation.

**Infer activity from task state or Worker phase.** These fields describe task
execution ownership rather than current provider activity and cannot distinguish
a normal question from an idle Session.

**Aggregate expanded children only.** This would hide a collapsed chain's
problem and omit its root or filtered members. The graph's ordinary component
membership supplies the correct scope without including external chains.

## Consequences

The display is bounded and intentionally incomplete: unknown or stale members
contribute no color, so working means only that observed members are working.
Refresh is polling and can lag a provider transition. The summary remains local
to the chain page; adding indicators to other surfaces requires explicit scope
and shared identity/visibility rules, not a second per-row Session client.
