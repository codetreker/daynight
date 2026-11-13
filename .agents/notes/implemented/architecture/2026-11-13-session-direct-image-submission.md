# Agent Note: Start Session image transfers with actual content

Status: implemented

## Problem

The legacy image upload and capture exchanges require a separate preparation or
registration before actual content is transferred. A client cannot start with
its first real bytes or submit a sealed capture without depending on that extra
exchange. Uncertain responses, late attempts and resource reclamation also need
stable identities so a retry cannot substitute different content or falsely
publish a resource.

## Decision

The Server accepts the first nonempty HTTP image chunk with its complete upload
specification and confirms only the durable prefix. It also accepts a capture
submission containing the original request, current attempt and one validated,
resource or failed outcome. The Server retains the existing identity, source,
authorization, publication and cleanup rules. Resource association and its
message pin share a Session transaction; a reclaimed resource cannot be revived.
Exact replay compares the original business content and returns the current
receipt. A later attempt cannot be overwritten by an earlier submission.
A first-chunk intent can commit before its file; backup verification allows that
unconfirmed file to be absent but checks its bytes when present. Confirmed
chunks remain mandatory. Recovery retains the original intent identity and
terminal-state cleanup rules.

Existing capability discovery and Controller upgrade responses advertise version
1 in an optional header. The legacy exchanges and response bodies remain
compatible. The Controller checks that header on each authenticated connection
and reports `upgrade_required` before sending a new submit to an unsupported
Server. Native and Markdown capture share local preparation, actual complete
history synchronization, immutable staging and direct submission. Source IO
depends on the acknowledged position, current source authority and local media
capacity, without a service registration or reserved receipt. The [image contract](../../../../docs/design/session-image-contracts.md)
owns the wire forms and recovery rules. Actual storage admission remains owned by
the [content capacity decision](2026-11-13-session-actual-content-capacity.md).

Before sending, the Controller persists the original request, current attempt,
outcome and sealed-file association. Transport request IDs and connection epochs
are supplied by each current relay connection. An uncertain submission queries
the original capture. Only an explicit `capture_not_found` under the same valid
Session and authorization permits replay of that frozen content; late original
frames still encounter the Server's identity and attempt checks. Missing sealed
bytes cannot authorize another source read. Receipt observation and exact retry
controls preserve the immutable initial request while advancing the separate
current attempt. Local source cleanup remains independent of service settlement
and must finish before replacing its attempt. A query validates the receipt before
releasing the current writer and rechecks the same local attempt after that join.
Definite nonretryable submission refusals settle the occurrence; they do not
become an endless query-and-replay loop.

Journal v12 converts unfinished registration, commit and failure state in the
database migration. Only an old registration whose source never started retains
permission to begin its first read after an exact same-attempt reserved receipt.
Frozen old outcomes can resume submission after that receipt or replay after a
correlated capture-not-found. Neither path recreates an interrupted source.

## Alternatives

**Require the existing preparation and registration exchange.** This preserves
the old consumer sequence but prevents starting the new flow with actual content
and ties it to a compatibility step that no longer reserves capacity.

**Create another quota or capability request.** An additional request would
reintroduce a prerequisite unrelated to actual content. The existing discovery
and upgrade responses can advertise protocol support without changing their
strict bodies.

**Recreate a capture or fetch its source after an unknown result.** A changed
source can produce different bytes and duplicate an operation that already
committed. The original identity and frozen outcome must instead be observed and
replayed only under the documented conditions.

## Consequences

Both direct and compatibility consumers retain the same persistence and error
boundaries. The first JSON request must fit the existing body budget, and a
consumer may need a smaller first chunk. Server support remains independently
deployable before a new Controller; a new Controller requires the advertised
capability and cannot silently fall back to compatibility registration. Durable
local state must retain incomplete cleanup and sealed-byte responsibility across
upgrades. A representative product journey replaces only the upstream native
agent with a controlled stdio peer while the compiled Controller, decoder,
service, database and archive path execute normally; it does not qualify live
third-party provider behavior or the module-owned failure matrix.
