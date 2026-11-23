# Agent Note: Remove Terminal Archive Writes and Recovery

Status: implemented

## Problem

Old terminal recording and recovery operations remain inside the server after
Worker endpoints stop accepting their protocol. They carry upload and execution
responsibilities even though historical recordings must remain independently
readable and old executions are managed by their users.

## Decision

Remove terminal archive upload and finalization writes, recovery operations and
live Worker state readback. The independent historical archive reader retains
its persisted record, authorization, integrity checks and residency permits.
The stored historical reader decodes only the fields needed for uploaded recordings.

This extends the [Worker terminal entry removal](2026-11-18-remove-worker-terminal-entries.md)
and retains the [history read boundary](../architecture/2026-11-17-terminal-history-read-boundary.md).

## Alternatives

**Keep internal upload and recovery for old executions.** This retains execution
responsibilities that users handle independently and provides no current endpoint.

**Delete the historical reader with the writer.** Uploaded recordings would lose
access and integrity checks even though their original bytes remain stored.

## Consequences

Existing uploaded recordings remain available under their original identities and
permissions. Unuploaded recordings cannot be supplemented through this server.
The [registry removal](2026-11-18-remove-terminal-registry.md) removes the
remaining live registration and state operations.
