# Agent Note: Task Archive Retention Decisions

Status: implemented

## Problem

An archive can arrive after its Task ends, while another member of the ordinary
dependency chain can finish later or reopen. A fixed deadline attached to one
Task cannot preserve the required reading period. Archive retries and legacy
format conversion also rewrite metadata, so its update time cannot establish
the first successful publication.

## Decision

The [storage contract](2026-11-18-session-storage-contracts.md) defines the
seven-day guarantee. Its [history design](../../../../docs/design/task-session-history.md)
owns the implementation and consumer contract.

Each ordinary Web Task Session has separate retention metadata. The archive's
existing publication transaction inserts the first server success time once.
Migration records an explicit seven-day grace deadline for existing ready
archives while leaving their original success time unknown. Duplicate receipts
and conversion preserve both facts.

A dedicated transaction acquires the Project lock before Session and archive
locks. It shares the existing Task writers' Project serialization boundary,
reads the current ordinary chain, executes the core rule and stores the result
with the observed member versions. Every directory or expiration consumer must
refresh in its protected transaction. Expired records cannot be revived by
refresh. Expiration still requires resource and access checks owned by cleanup.

## Alternatives

**Recompute every archive on each Task or dependency mutation.** This makes
ordinary writes scan retained archives and introduces more cross-module work
into their transactions. Refresh on consumption keeps that cost with the
consumer, at the cost of requiring the protected refresh contract everywhere
the deadline is used.

**Use the existing Task cache epoch as a freshness fence.** That epoch does not
change on every terminal-state or dependency mutation. A matching epoch cannot
justify expiration. The existing Project lock protects the complete mutable
chain, including newly connected members that were absent from an old snapshot.

**Derive the original success from archive updated_at.** Retries and conversion
can rewrite that field. Keeping it as an apparent first success would silently
extend deadlines and conceal unknown historical times.

## Consequences

The decision is reproducible from persisted member versions and timestamps;
its cached deadline alone has no authority after the transaction ends. Long
unfinished chains retain their archives, and unknown terminal times prevent
scheduling. Traversing the complete ordinary chain costs work proportional to
its membership and holds the Project shared lock until persistence finishes.
The dedicated scope preserves existing lock order instead of upgrading locks
inside an archive publication transaction.

This module supplies calculation and persistence. The
[cleanup consumer](2026-11-19-task-archive-cleanup.md) owns read-admission
revocation and physical reclamation. Versioned directories remain a separate
consumer; storing retention records does not declare their HTTP capability.
