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
compatible. Server support is deployed independently; the existing Controller
continues its register and commit flow. The [image contract](../../../../docs/design/session-image-contracts.md)
owns the wire forms and recovery rules. Actual storage admission remains owned by
the [content capacity decision](2026-11-13-session-actual-content-capacity.md).

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
consumer may need a smaller first chunk. The Server can accept direct capture
submissions before the Controller adopts that path; advertising Server support
does not claim that a particular Controller has switched protocols.
