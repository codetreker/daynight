# Agent Note: Copilot Graceful Native Exit

Status: implemented

## Problem

The Copilot runtime can acknowledge shutdown before its operating-system process
emits `exit`. Signaling the still-running child immediately after the RPC and
transport cleanup interrupts an otherwise successful graceful shutdown.

## Decision

After a successful shutdown acknowledgement, the owner waits up to 1500 ms for
the original native child to exit before its existing TERM/KILL escalation.
Force cleanup and shutdown without acknowledgement enter that escalation
directly. Cleanup retries retain the original shutdown result, exit observation,
and signal state. This refines the shutdown ownership in the archived
[SDK runtime decision](../../archived/architecture/2026-10-28-copilot-web-sdk-runtime.md).

## Alternatives

**Signal immediately:** This bounds shutdown but turns the normal gap between
the RPC acknowledgement and process exit into unnecessary termination.

**Wait indefinitely:** This avoids a signal for slow exits but cannot release
ownership when the native process does not stop.

## Consequences

Graceful shutdown can take an additional bounded interval before escalation.
An acknowledgement is not proof of process exit, and failure to observe exit
still leaves cleanup unconfirmed. The [probe stop decision](2026-11-14-copilot-probe-stop-confirmation.md)
separates a failed graceful RPC from confirmed final SDK transport and native
process closure when deciding whether a probe result can be returned.
