# Agent Note: Complete Task Properties in Summary Synchronization

Status: implemented

## Problem

A task property can be absent, explicitly empty or changed by the worker
lifecycle. A summary feed that only signals its task version cannot expose those
current values in its durable project snapshot. Adding values without changing
the cache format would leave unchanged old tasks without properties and could
misinterpret missing cached fields as an empty object. Concurrent writes and
failed cache commits must preserve the same task/version facts and coverage.

## Decision

The [task-sync architecture](../../../../docs/design/daynight-task-sync.md)
includes a required complete properties object in every snapshot and delta task
record. The store closes task rows and batch-loads property rows through the
[property-row model's](2026-10-30-task-property-rows.md) shared loader in the same
repeatable-read snapshot. Parent visibility and whole-project graph capacity
checks precede property reads. Empty task sets issue no property query, and tasks
without property rows emit an empty object. The loader validates stored values
through their definitions and preserves error causes.

Property changes retain the task's existing version/updatedAt transaction. A
higher task version replaces the complete summary and property map, propagating
removed keys without property tombstones or another watermark. Ordinary property
changes do not rotate server epochs. Equal-version summaries compare every own
property key and JSON value semantically: object order is irrelevant, array order
is significant, and absence differs from null or an empty array. Older responses
cannot restore removed properties. Property names and values are not a second
client-side catalog; generic readers preserve all JSON keys.

Invalid stored properties are captured as an invalid_input refusal within the
read-snapshot callback. A successful snapshot completion precedes returning that
HTTP 400 refusal. Database queries and transaction-completion failures remain
HTTP 500 and take precedence over a saved refusal, including when an error chain
also contains property validation. A failed operation returns no partial tasks.
Delta validation covers its selected task set, not unreturned historical rows.

IndexedDB schema 3 rebuilds projects, summaries and details and rotates user
fences for both 2-to-3 and direct 1-to-3 upgrades. Clearing old epochs and
watermarks forces a complete snapshot, including tasks unchanged since the old
format. An old missing field cannot be repaired with an inferred empty object.
Upgrade failures roll back. Old connections close on versionchange, and stale
fences cannot publish across the replacement.

The summary map keeps complete properties, while graph-node projection explicitly
drops them. Detail-to-summary comparison uses the same complete property equality.
Details still require their existing online admission and opening live GET;
cached property values confer no read or mutation authority. Summary rows,
detail invalidation and watermarks commit together before memory publication or
cross-tab hints. Network, decoding, quota and transaction failures preserve the
previous valid cache and coverage with a visible error.

This partially supersedes the property-free projections recorded by the
[summary API](2026-10-24-task-summary-window-api.md) and
[persistent-cache](2026-10-24-persistent-task-summary-cache.md) decisions. Their
original compact feed avoided repeated complete property payloads while detail
GETs owned full content. Their timestamp-window selection, identity, atomic
merge, lifecycle and detail-admission decisions remain in force.

## Alternatives

**Keep properties behind detail GETs and synchronize only versions.** This keeps
summary payloads compact but does not put complete current properties into the
project synchronization result. It cannot satisfy property synchronization or
propagate property absence within the durable summary collection.

**Send property names or per-property tombstones.** Names cannot convey values;
tombstones would add property-level merge and history semantics alongside the
existing task version. Whole task records already provide the required latest
state and removal semantics.

**Add pagination, streaming staging or project property-byte budgets.** These can
bound individual transfers or storage work, but require new completeness,
publication or rejection contracts. The selected scope accepts complete property
payloads and preserves explicit network and quota failures without silent
truncation. Those mechanisms need a separate synchronization contract if required.

## Consequences

Property presence and worker lifecycle values survive snapshot, delta,
persistence and cross-tab rereads. Task/property values belong to one database
snapshot, and the shared batch loader avoids per-task queries. Unchanged task
versions reuse existing rows and graph/index references; real property changes
still follow the existing task-level invalidation path.

Complete properties increase response, parsing, full-set validation and summary
storage costs. The 1,000-task/5,000-edge limits constrain graph structure, not
property bytes. The 1 MiB write-request envelope does not bound accumulated task
properties, and the 8 MiB detail LRU budget does not cover summaries. No promise is
made that every legal maximum data set fits every browser quota. Actual project
samples, near-request-limit PR values and multi-task large-property samples need
source-bound byte, parsing and IDB timing observations. A failed response or
quota commit must not publish incomplete properties or advance coverage.

The wire and cache format require coordinated server/Web deployment. No event
history, arbitrary product properties, property-level versions, telemetry upload
or additional resource cap is introduced. Exact int64 decoding remains limited
to resource version positions; an ordinary version field inside a property value
retains its JSON type.
