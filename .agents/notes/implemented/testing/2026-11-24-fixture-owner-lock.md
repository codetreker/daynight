# Agent Note: Concurrent fixture ownership operations

Status: implemented

## Problem

A product E2E run records launch and cleanup ownership in shared files. Calls
from different processes must not overwrite those records, while concurrent
operations in one process must allow the current owner to complete asynchronous
file work. A synchronous SQLite busy wait on the same event loop prevents that
owner from progressing and can fail otherwise valid concurrent fixture commands.

## Decision

The [product E2E fixture](2026-11-08-self-contained-product-e2e.md) queues
ownership operations by their validated run directory within each process.
Each turn retains the SQLite transaction for cross-process exclusion and its
existing bounded contention behavior. The queue releases its turn after success
or failure; no turn enters SQLite while an earlier operation in that process
still holds the transaction.

## Alternatives

**Serialize only one scenario's reads.** Other concurrent fixture operations use
the same ownership records and could encounter the same event-loop blockage.

**Replace the cross-process lock with an in-memory queue.** Independent recovery
and the original runner can be different processes and require a shared lock.

## Consequences

Concurrent commands in one run can record and finish their ownership without
blocking their own transaction holder. Different processes still contend through
SQLite, and a long-lived external holder can cause a bounded refusal. Per-run
serialization delays later ownership operations until the current turn finishes;
it does not change the actual command execution or recovery guarantees.
