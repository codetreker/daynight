# Agent Note: Bot Read Poll Lifecycle

Status: implemented

## Problem

Bot and assistant task reads kept a five-second interval while disabled, hidden,
or without a detail target. The interval could not perform useful work but kept
waking the page. A cancelled read could also outlive its eligibility and affect
later state or authentication handling if its network signal was not cancelled.

## Decision

The existing resource-specific `useBotRead` and `useBotDetail` owners start a
polling cycle only while enabled, visible and within a valid account scope;
detail also needs a Bot ID. Each cycle reads immediately and owns one interval.
Stopping a cycle clears the interval and cancels its GET or detail cache ticket.
Committed lifecycle changes revoke the old cycle in the layout phase. Setup
creates its resources, and late work is fenced by its cycle and signal.

Manual refresh uses the same admission and single-request checks without another
timer. Cancellation preserves safely displayable data and drafts, while actual
failures retain their existing error and stale behavior. The account admission
check remains at the read boundary and the parent's `readEnabled` continues to
drive recovery. The [management decision](../architecture/2026-11-05-bot-management-web.md)
owns the broader page and creation identity; the [design](../../../../docs/design/bot-management-web.md#读取与展示)
describes the current read and cache responsibilities.

## Alternatives

**Keep the interval and skip work on each tick.** This avoids requests but still
wakes inactive pages every five seconds and delays a resumed read until a tick
unless a separate immediate path is maintained.

**Introduce a generic polling framework.** The two existing owners already
encode resource keys, cache tickets and cancellation. A shared framework would
add an abstraction and ownership boundary without a demonstrated caller need.

## Consequences

Inactive reads hold no polling timer or in-flight GET. Resumption creates a new
cycle without clearing the same-resource display cache, and each resource remains
serial. The hooks retain separate lifecycle code because detail cache selection,
ticket acceptance and deletion observation have distinct responsibilities.
This decision does not change account-wide authentication, deletion mutation
settlement or the network and storage formats.
