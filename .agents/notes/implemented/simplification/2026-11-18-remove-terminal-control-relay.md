# Agent Note: Remove Terminal Control Relay

Status: implemented

## Problem

Browser and Worker terminal control endpoints have been removed, leaving control
use cases and transient input bodies with no production callers. Retaining them
obscures the remaining historical and native Session responsibilities.

## Decision

The server removes terminal command submission, operation lookup, polling,
Worker control messages and disconnect handling, together with the transient
command body cache. Historical archive reads and native Controller relay are
independent of the removed control path. The later [registry removal](2026-11-18-remove-terminal-registry.md)
removes the remaining live state and its project-retirement handling.

This follows the [Worker entry removal](2026-11-18-remove-worker-terminal-entries.md)
and narrows the terminal part of the [Session engine boundary](../architecture/2026-11-05-server-session-boundaries.md).

## Alternatives

**Retain the unused control implementation.** It would keep an unreachable input
and relay path after its producers and consumers have left.

**Remove all terminal state together.** Registry and project retirement still call shared helpers; removing those with the control use cases
would combine separate responsibilities and break their callers.

## Consequences

No transient terminal command bodies or control operations can be submitted by
the server. Uploaded archive reading and Web/Controller
Sessions retain their existing access and lifetime rules.
