# Agent Note: Bind an online relay mode to Session execution

Status: implemented

## Problem

Repeated complete online history uploads make long Sessions spend increasing
network, Server and PostgreSQL work on content already held by the Controller.
Image sends and captures still need authorization, durable identities and
resource references even when the Server does not hold that online history.
The final archive needs the original execution's content policy and a complete
closure after the writer stops.

## Decision

An authorized Controller connection binds the online mode and history content
policy to a new execution. Opt-in peers receive the persisted decision in the
welcome; existing executions retain legacy mode and reconnects read the same
decision. Relay mode does not create an active bundle and refuses its ledger
endpoints. Controller-owned occurrence verification and the current source ACK
replace the complete-history checkpoint for new direct captures. The Server
retains its authorization, fence, immutable capture, attempt and receipt checks.
Image upload and capture publication share the Session lock and count distinct
available originals against the online byte and resource limits. The stopped
archive checks its fixed policy and the complete final closure under the existing
combined capacity limit.

The [image contracts](../../../../docs/design/session-image-contracts.md) and
[archive design](../../../../docs/design/session-image-archives.md) own the wire
and accounting details. This changes online admission for relay executions from
the complete-history requirement in the [direct submission decision](2026-11-13-session-direct-image-submission.md)
and the combined online accounting in the [content capacity decision](2026-11-13-session-actual-content-capacity.md);
their legacy-mode and recovery rationale remains applicable.

## Alternatives

**Keep complete or incremental active history on the Server.** Both retain an
online history ledger and its synchronization and storage cost even though the
Controller already owns the content.

**Upload complete history only when sending or capturing images.** This moves
the same growing transfer onto interactive operations and keeps their success
dependent on the complete online history upload.

## Consequences

Relay operation requires both sides to understand the fixed mode and occurrence
proof; older clients remain on their existing mode and cannot silently attach to
a relay execution. Server media capacity is independent of online text capacity;
the combined final archive can still fail while retaining the original source.
The existing Controller continues using the legacy path until it adopts relay.
