# Agent Note: Stop Session transport while retaining the display

Status: implemented

## Problem

An account change requires immediate withdrawal of remote Session access while
the existing page and local input remain visible. A pending request may have
been sent with a different account's credentials, and its late result cannot
be installed in the retained view. Live Sessions and fixed records both own
remote media readers.

## Decision

The Session client has an irreversible, synchronous account-refresh stop. It
revokes remote admission, cancels requests and timers, closes transport and
media readers, and retains the timeline, draft and image scope. A trusted
snapshot for a different principal stops the client before notifying its root
owner and is never installed. Fixed-record media has the same independent stop
and preserves its displayed image leases. The root owner retains authority to
invalidate the view for actual revocation or its existing account policy.

The [Session protocol](../../../../docs/design/task-session-protocol.md) and
[browser image design](../../../../docs/design/session-image-browser.md) own
the lifecycle and presentation contracts.

## Alternatives

**Use the temporary authentication suspension.** It retains a channel for up
to sixty seconds and can resume, so it cannot enforce immediate account stop.

**Invalidate or close the existing owner.** This stops transport but also
destroys the timeline, local draft and image leases needed for retained display.

## Consequences

The retained content does not authorize further reads, downloads or commands.
Already dispatched writes can have an unknown outcome; local cancellation does
not roll them back. Terminal and root account integration apply the same stop through their respective lifecycles.
