# Agent Note: Stable Terminal Presentation During Recovery

Status: implemented

## Problem

Visibility and identity checks interrupt the terminal transport even when the
execution and its contents have not changed. Treating that interruption as a
new loading or expired presentation shifts the existing screen and can discard
a confirmation, while retaining the old lease as input authority would allow
commands before the new connection confirms control.

## Decision

Retain the last confirmed screen and business control state separately from
transport readiness. Pausing closes the viewer channel and stops automatic
receipt polling and lease renewal; input remains disabled until a fresh channel
observation matches the current execution fence and control epoch after the
recovery read. Same-identity confirmations and drafts survive the pause; a real
identity or control change invalidates the old confirmation. Real failures and
unknown operation results retain their existing handling and are not replayed.
When a state read and channel observation disagree, bounded read-only
reconciliation keeps input fenced until they agree. It does not close the
channel, which would release the browser's lease.
The [Herdr Session design](../../../../docs/design/herdr-session-web.md) owns
the resulting page and admission behavior.

## Alternatives

**Use the retained lease to reopen input after the state read.** This would
shorten recovery but the old channel may already have released or lost control;
the read alone does not establish a fresh channel's ownership.

**Replace the screen with a loading state during each reconnect.** This exposes
transport progress but changes layout and obscures confirmed content during an
ordinary background check.

## Consequences

Readers retain their place through a same-data check while control remains
fenced. Recovery can take longer than the state GET, and real failures remain
visible. This preserves the channel and ownership rules of the
[original Herdr Session decision](../architecture/2026-11-05-herdr-session-web.md)
without changing the server lease or input protocol.
