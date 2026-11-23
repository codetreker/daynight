# Agent Note: Codex response token usage

Status: implemented

## Problem

Codex cumulative/context snapshots cannot identify non-overlapping consumption.
Users need actual Task token measurements across retries and native recovery,
while missing response details and child threads must remain explicit gaps.

## Decision

The [usage contract](../../../../docs/spec/task-token-usage.md) admits a separate
Codex 0.169.0 response profile. It hashes the complete thread/response identity
and counts immutable per-response metrics from opted-in notifications and the
original thread's validated rollout. Persisted turn attribution retains the
originating state when recovery reads an old response. Unbound history remains
unattributed. Journal format 019 protects the new metadata from older readers.
Read-only observations retain shipped formats 016–018 without upgrading an active
owner; exited journals still require their original storage permit to migrate.

This replaces the Codex unsupported-only choice described by the
[single-table decision](../architecture/2026-11-18-single-table-token-usage.md),
while retaining its single ledger, independent ACK and qualification rules.
The old snapshot profile and old states remain unsupported.

## Alternatives

**Difference cumulative snapshots.** Context recalculation and synthetic totals
do not provide a stable response revision. Differences would invent precision.

**Use only raw notifications.** Cold resume disables these notifications and
incomplete responses may only reach the rollout. The original returned file
provides complementary evidence without scanning unrelated session directories.

**Treat native zero details as known zero.** Codex defaults absent upstream
cache/reasoning details to zero. Only positive details establish an available
submetric; cache-write semantics remain unknown.

## Consequences

Actual observed response input/output/total become available without changing
native execution identity or adding a server table. SHA-256 preserves long
opaque identities within ledger field limits. Source deduplication and original
grants remain authoritative across upload retries and recovery.

Rollout persistence is best-effort; child threads and unbound historical turns
remain outside coverage. The profile is always partial and requires explicit
0.169.0 deployment qualification. Unknown models/details remain null. Older CLI
binaries cannot resume the new journal format; compatible rollback retains the
format and disables the response profile.
