# Agent Note: Account-owned Worker Runtime Snapshots

Status: implemented

## Problem

Task claims identify execution ownership, but they cannot describe an idle
Worker or establish whether its process has reported recently. Task timestamps
change for business reasons, and unchanged execution summaries are deliberate
no-ops. Attaching machine liveness to those writes would either miss active
Workers or turn observation into task mutation. Old task observations must also
stop disclosing titles when current project access is revoked.

## Decision

The service owns one latest runtime snapshot per authenticated user and stable
Worker ID. The [snapshot contract](../../../../docs/spec/daynight-worker-snapshots.md)
defines report, list and detail resources; the
[design](../../../../docs/design/daynight-worker-snapshots.md) owns their
transactions and read models. The existing
[claim foundation](2026-10-24-worker-claim-foundation.md) retains execution
authority. The [runtime reporting decision](2026-10-28-worker-runtime-reporting.md)
owns the CLI producer's independent scheduling, read-only collection and
process-local lifecycle.

A dedicated workers row atomically stores server observation time, validated
telemetry and a server-normalized task snapshot. Client reports carry task
references, not authoritative task status or titles. Primary-key batch reads
and the worker property-row codec validate current claim ownership without
scanning every project's tasks or converting opaque task properties to JSONB.

Report writes use their own READ COMMITTED transaction and compete only for the
Worker row. A timestamp guard prevents older observations from replacing newer
ones. An ignored UPSERT is followed by a separate statement that can observe a
concurrently committed conflict row; a same-statement CTE does not provide that
visibility guarantee.

Read-only snapshots reapply current project membership and undeleted-task
visibility to saved task arrays and counts. They retain the recorded status and
phase even if the current claim later completes or changes. Unknown inventory,
known empty inventory and stale inventory remain distinct. The 120-second
online rule and 72-hour visibility window have no claim-control side effects.

## Alternatives

**Use claim summary writes as heartbeats.** Idle Workers have no claim, and
stable summaries intentionally avoid writes. Forcing updates would add task
version churn and mix execution ownership with process observation.

**Derive each report from all task claims.** Project-wide inventory reads are
designed for execution reconciliation and may scan unrelated candidates before
filtering ownership. Supplied references allow bounded primary-key reads while
the service still supplies all authoritative task fields.

**Persist every report as history.** Historical measurements need retention,
query and consistency policies beyond a current runtime view. A latest row
satisfies liveness and last-observation behavior without inventing those
policies; it cannot later reconstruct measurements that were never retained.

## Consequences

The account can discover a reporting Worker with no tasks, while execution
continues to use the existing protected claim protocol. Current authorization
filters old observations on every read, and a stable creation-time cursor does
not move when heartbeats arrive.

The service adds one table, strict public DTOs and independent observation
transactions. Freshness still depends on successful client reports; GET never
renews it. Installation or resource values are client observations whose shape
and range are validated, rather than proof of a running collector. Old claims
are not backfilled as active Workers, and the latest snapshot does not provide
resource history.
