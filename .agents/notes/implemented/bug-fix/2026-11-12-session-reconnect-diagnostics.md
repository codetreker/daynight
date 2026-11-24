# Agent Note: Preserve Session reconnect failure provenance

Status: implemented

## Problem

A Controller can complete its handshake and source synchronization, then lose
its WebSocket when a later server operation fails. A generic Session not-found
message does not identify whether the Session or an associated record was
missing. A subsequent history-upload HTTP conflict can obscure the first
failure. Existing logs collapsed Controller operations into one channel phase
and discarded structured HTTP error identifiers.

## Decision

The protocol adapter records fixed Controller connection, source, fence,
message-handling and polling stages. Message types come from the Controller
protocol's finite vocabulary. Selected internal storage phases are mapped to
fixed diagnostic identifiers; arbitrary error text remains excluded. Public
WebSocket errors and connection-close behavior retain their original semantics.

The history-sync client records whether status lookup or chunk upload failed,
the HTTP status, and bounded, validated error and request identifiers. The
shared archive error reader retains its 64 KiB business parsing limit and the
original request deadline and cancellation. Diagnostic extraction uses only a
complete envelope of at most 16 KiB and never reads the body again. Formatting
preserves the original ArchiveRequestError, capacity classification, retry
budget and original-receipt reconciliation. Transport and cancellation failures
retain their existing classification. Logging never adds a request or replaces
the frozen synchronization identity.

The [design](../../../../docs/design/session-reconnect-diagnostics.md) owns the
field restrictions and original-Session recovery conditions. This change
improves diagnosis; it does not establish a production disconnect root cause.

## Alternatives

**Ignore not-found or HTTP conflicts.** These responses also protect permissions,
connection generations and archive integrity. Treating them as success without
proving the affected business condition would conceal real refusals.

**Replace the Session or discard its history intent.** This changes original
execution identity or loses the evidence needed to resolve unknown submissions.
The existing receipt protocol can settle an old-epoch upload and advance.

**Log raw server bodies and database errors.** Those values can contain user
content or credentials. Fixed stages and constrained identifiers retain useful
provenance at the cost of requiring further internal evidence for some failures.

## Consequences

Operators can distinguish the first failed Controller operation from later
history-sync failures without changing execution or retry behavior. The design
requires a concrete reproduction before modifying the underlying recovery rule.
The original standalone diagnostic reader had a 16 KiB total read limit.
Shared archive parsing now owns response consumption and may need up to 64 KiB
for business classification; keeping a separate 16 KiB extraction budget avoids
changing capacity decisions merely to collect diagnostics.
Production recovery still depends on locating the actual failure, delivering any
necessary business fix and verifying the original Session after deployment.
