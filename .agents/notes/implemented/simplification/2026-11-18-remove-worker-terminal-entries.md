# Agent Note: Remove Worker Terminal HTTP Entries

Status: implemented

## Problem

Old terminal Worker entry points can accept registration, control and archive
writes after Workers have stopped producing that protocol. Historical recordings
still need authorized, integrity-checked reads and native Sessions retain their
own independent protocol.

## Decision

The server exposes v2 terminal history, archive status and content as read-only
operations. It no longer connects Worker registration, channel, messages,
recovery, evidence or archive writes to HTTP, and does not advertise live Herdr
capabilities. Native v1 routes remain available. Internal terminal operations
with remaining references stay in their existing owners.

This extends the [read-only Web terminal decision](2026-11-17-web-terminal-history.md)
and preserves the [history read boundary](../architecture/2026-11-17-terminal-history-read-boundary.md).

## Alternatives

**Keep Worker endpoints for old executions.** That retains an execution and
recovery path for resources whose lifecycle remains the user's responsibility.

**Remove the entire terminal implementation.** Internal callers and the historical
archive reader still need distinct mechanisms; removing them together would break
retained behavior and conflate separate responsibilities.

## Consequences

Uploaded recordings keep their identity, access checks and original-byte integrity;
unuploaded recordings remain unavailable. Old Worker clients cannot resume or
upload through these endpoints. Removing HTTP assembly does not itself remove the
remaining internal terminal operations.
