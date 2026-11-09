# Agent Note: TaskSync Session state projection

Status: implemented

## Problem

Task chain annotations need only a reliable current binding and a small activity
classification. Reading complete Current responses separately for every relevant
Task repeats authorization, transaction and live-content work, and transfers
catalogues, controls and startup data that those annotations do not use. The
cost grows with the number of Task rows while the project already has a periodic
TaskSync read. Reducing this cost must preserve current Session classifications,
shortcuts, unknown-state behavior and execution identity checks.

## Decision

TaskSync returns a required complete `sessions` map keyed by Task ID, with only
`working`, `notice`, `warning` or `pending` values. The map is independent of the
Task timestamp window and carries no additional Session version, cursor or
execution identifiers. Its producer creates a non-null map, including a valid
empty object, and the HTTP converter preserves that result without a fallback.

A narrow read-only SessionReader shares TaskSync's existing database snapshot.
It reads the relevant in-progress Tasks' Worker binding and current persisted
Session scalars in one project query, decodes their canonical fields normally,
and avoids content, catalogues, operations and mutation capabilities. The
[canonical batch-read decision](../simplification/2026-11-09-task-canonical-batch-reads.md)
removes stored-field and capacity revalidation while preserving actual binding
and Engine fence comparisons.
TaskSync accepts a consumer-owned single-method `SessionStateReader`, and
application composition supplies the existing shared Engine. This preserves a
narrow dependency on state reads rather than the Engine's content and lifecycle
API. The shared Engine separately reads committed live scalars under short cell locks.
Registry references are captured before cell reads, and any registry recheck
occurs after the cell unlock, preserving lock order. The resulting observation
is consistent for durable bindings but does not claim one atomic instant across
PostgreSQL and all live cells.

Projection preserves existing semantics. Reliable initialization or
synchronization produces pending without an annotation. Unreliable durable
bindings and active, non-disconnected unknown activity contribute no key.
Missing live state or a mismatched controller fence uses the existing
disconnected fallback and contributes warning. Durable LastSeen and DrainUntil
retain their exact timeout rules. Reading this map does not advance lifecycle,
archive data, change controller/report behavior or grant content access.

The [TaskSync requirements](../../../../docs/spec/daynight-task-sync.md) and
[design](../../../../docs/design/daynight-task-sync.md) own the wire and read
mechanisms. The [list admission decision](2026-11-08-task-sync-session-list.md)
owns the page producer, request bindings and receipt lifetime used by the Web
consumer. The [original annotation decision](../../archived/feature/2026-11-04-task-session-status.md)
established page-local annotations, complete ordinary chain membership and
reliable execution binding. Its per-Task Current read was reasonable when that
endpoint supplied the necessary authoritative observation; this decision
provides a dedicated lightweight server projection while retaining those
presentation and identity requirements.

## Alternatives

**Keep full per-Task Current reads with a longer interval.** A longer interval
reduces frequency but retains repeated content and transaction work, separate
request scheduling and payload growth with Task count.

**Add a lightweight per-Task status endpoint.** Payloads become smaller, but the
number of requests and the separate scheduler still grow with relevant Task
count. Its independent observations also need their own Task binding admission.

**Make TaskSync import the concrete Session Engine.** That exposes more than
the consumer needs and introduces a package cycle through existing core Session
tests that consume the Task service. The consumer-owned one-method interface
keeps production composition on the same Engine and preserves independent
module validation.

**Push Session deltas or add another versioned feed.** Replay, subscription
recovery and freshness would require a new protocol and state owner. A complete
minimal map fits the existing project read without a second incremental history.

## Consequences

The server provides every current reliable contribution with one narrow project
query and scalar live reads. Map work and bytes grow with relevant Task bindings.
At the original 1000-Task read limit, the compact map added approximately 49,001
bytes plus the field name and envelope; that calculation explained the earlier
bound, without measuring resource savings. Current reads impose no such Task
count or response-byte admission.

The complete map is re-read on each successful sync even if Tasks do not change.
Ordinary Worker decoding and live mutex waits remain real work; mutex waits cannot be
instantly cancelled. No cross-instance live-state bus is introduced, so missing
local live state preserves the established disconnected projection. Any query,
natural decode, Engine admission, encoding or transaction failure fails the
complete sync. No partial success or silent empty fallback is added. Task
properties are loaded in one batch, and full Current remains the content and
authorization owner.
