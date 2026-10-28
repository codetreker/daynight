# Agent Note: Session Connection Reuse During Identity Checks

Status: implemented

## Problem

Switching applications makes a healthy Session View close its WebSocket and
show a recovery notice on return. This interrupts reading even when the account
and native agent have not changed. Identity checks must continue to isolate
new content and operations while the current browser account is unconfirmed.

## Decision

Separate temporary identity suspension from invalid task or account ownership.
The Session client retains a healthy connection for up to 60 seconds, freezes
new content publication, and buffers at most 1000 messages or 4 MiB. Same-account
verification releases ordered messages without reloading history. In-flight
HTTP results wait for verification; negative authorization remains immediate.
Timeout, buffer exhaustion, and transport failure reconnect from the consumed
cursor. Account or scope invalidation closes the connection and clears owned
state. Stale transport callbacks cannot disconnect a replacement connection.

The composer retains its draft and connection presentation while control actions
are disabled. This extends the [silent foreground identity policy](2026-10-23-silent-foreground-identity-checks.md)
to Session transport without changing its account-checking requirements. The
[Session design](../../../../docs/design/task-session-protocol.md) owns the
current transport and recovery contract.

## Alternatives

**Disconnect on every identity pause.** This bounded stale transport lifetime
but caused a visible recovery cycle on ordinary app switches, even with a
healthy connection and unchanged account.

**Keep the socket while discarding paused events.** This avoided reconnects but
lost events and could advance the cursor beyond content never applied locally.
Bounded buffering with replay fallback preserves continuity and completeness.

**Skip foreground identity checks.** This removes the trigger but allows a tab
to continue acting on stale account assumptions. Existing identity isolation is
retained instead.

## Consequences

Short app switches retain the connection, rendered history, and draft. Background
memory and connection retention are bounded. Longer absences or actual failures
still require recovery. The client preserves uncertainty for pending operations;
reconnection never resends an agent input or restarts the native agent.
