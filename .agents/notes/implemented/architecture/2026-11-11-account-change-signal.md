# Agent Note: Account Change Signal

Status: implemented

## Problem

Same-origin tabs need a way to notice a confirmed account change without treating
an old event as the current account or confusing unavailable storage with logout.
A local notification also needs to expose partial failure when the shared record
was written but another tab could not be notified.

## Decision

The Web account signal stores a canonical lowercase user UUID as a JSON string or
an explicit JSON `null` under `daynight.activeUser`; a missing key is unknown.
It rejects malformed values and preserves underlying storage and channel errors.
A successful change writes first and broadcasts the fixed `identity-changed`
message on `daynight-identity`. Storage, channel, focus and visible events prompt
subscribers to read the current record; event payloads do not establish identity.
A same-value publication is a no-op unless a failed notification remains pending.
Notification retry rereads the record and sends only while it still matches the
expected value, without rewriting it. A different known value supersedes retry.
The signal closes its channel and listeners on disposal and cannot authorize a
session or call an identity API. The existing authentication lifecycle has not
yet adopted this independent module.

## Alternatives

**Recheck `/me` on every foreground return.** The existing
[foreground verification decision](../../archived/bug-fix/2026-10-23-silent-foreground-identity-checks.md)
protects request admission but requires a network check and gate even when the
account has not changed. A local signal provides a separate change hint without
making the stored value an authentication authority.

**Carry the account in each notification or add persistent ordering.** A delayed
message could describe an older state; persistent versions, locks or a queue add
coordination and failure modes beyond the current-state hint. Reading the shared
record on notification avoids applying stale payloads.

## Consequences

Storage and channel failures remain observable, and a partially published value
can be notified again without overwriting a newer known account. Notification
completion proves only local steps, not delivery to every tab. Browser storage,
Cookie changes and broadcasts are not atomic; frozen tabs check the current
record when they resume and cannot observe a missed intermediate change that has
already reverted. The module does not itself change the existing workspace or
foreground authentication behavior.
