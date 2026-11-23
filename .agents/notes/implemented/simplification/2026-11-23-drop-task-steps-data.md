# Agent Note: Drop Task Steps Data

Status: implemented

## Problem

Retired Steps have no supported reader or writer, but their stored rows remain,
including rows belonging to soft-deleted Tasks. The data must be removed without
changing parent Tasks or their materials.

## Decision

Migration 124 drops `task_steps` in the migration transaction. The historical
migration and its checksum remain intact, and new databases use a snapshot without
the table. No per-row events, exports or address rewrites are produced. This follows
the separate [storage code retirement](2026-11-23-retire-task-steps-storage.md).

## Alternatives

**Keep or archive the rows.** This retains data after the confirmed retirement and
would require an additional ownership and access contract.

**Delete rows individually.** This adds work and event semantics that the retired
resource does not require; dropping the table also removes its obsolete schema.

## Consequences

The deletion is irreversible without a matching backup. Drain and stop old servers
and workers before migrating; the migration lock does not stop their access. A
failed migration rolls back its DDL and ledger entry. After commit, older binaries
reject the new ledger, so recovery requires a compatible build and forward repair.
