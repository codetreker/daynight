# Agent Note: Preserve unknown Worker configuration as source facts

Status: implemented

## Problem

A service can add configuration fields before every Worker implements them. A
closed response parser stops an older Worker, while dropping unknown members or
round-tripping them through JavaScript numbers loses stored intent. Changing a
future field can also unnecessarily replace known application records and cancel
work already preparing the unchanged known target. Remote observation items are
facts from a prior report and cannot become this process's application evidence.

## Decision

Configuration responses use explicit source wrappers containing validated JSON
and a strictly derived known view. The endpoint decoder retains text for GET,
ordinary report receipts and prompt-combined receipts. Only known paths enter the
existing type, identity and revision validators. Unknown nested members and item
kinds remain source facts; they create no execution or application results.
Configuration-local semantic comparison uses decoded strings, unordered object
members, ordered arrays and exact decimal digit/exponent tuples. It does not
change the global API serializer or convert unknown numbers through floating point.

The current schema 7 keeps `authority.desiredJson` as the sole persisted target and records
`applicationRevision` separately from the received revision. Known target changes
reconcile normally. Unknown-only, timestamp-only and forward revision-only changes
preserve generation, record identities, in-flight jobs and the application anchor.
Tool targets, native proofs, deferred Project confirmation and removal origins use
that anchor. Report envelopes name the newest desired revision; items keep their
actual target revision. Independent `remoteObservation` retains only the last
explicit GET's source and revision, which may lag the current observation baseline. A service rollback or null reset
retains that snapshot under its original counters without presenting it as current
application evidence.

Schemas 1–4 retain their structural conversion to validated schema 5, followed by
5→6. The conversion preserves generation, record identities, origins, actual-value
provenance, failure budgets, cursors and references. Historical desired becomes a
JSON string, its revision becomes the application anchor, and remote observation
starts null. The existing atomic checkpoint owner publishes only after save and
retains original files and errors on failure. Raw documents inside strings leave
the outer incremental cache guard unchanged.

This decision partially supersedes the [canonical authority decision](2026-11-12-worker-configuration-canonical-authority.md).
Authenticated GET still restores lower service state or null. Equal-revision
content must be semantically identical wherever both projections expose it;
existing mode and tool negotiation may omit their fields without changing the
stored revision. When both expose a field, its unknown subtree is compared too.
The cache retains same-revision hidden source fragments as historical facts,
not executable targets, and checks them when that revision exposes them again.
Other conflicting content is a protocol error. A late lower receipt settles only
its captured observation and cannot replace a newer desired document. Lower
receipt counters schedule an authenticated read so an actual service rollback
can still converge. Known target changes or authority rollback renew generation;
ordinary receipt and unknown-only installation do not.
The [Worker design](../../../../docs/design/daynight-worker.md#云端接收与本机提交)
owns the mechanism, and the [configuration contract](../../../../docs/spec/daynight-worker-configuration.md#worker-响应的未知内容保留)
owns consumer behavior.

## Alternatives

**Remove exact-field checks and rebuild the known DTO.** This accepts a response
but discards unknown data at the next state transition or cache write. It also
rounds integers when a full JSON object is decoded through ordinary numbers.

**Persist a typed known object alongside the raw target.** Two editable target
representations can disagree after migration or a state transition. A derived
in-memory view retains one persisted source of truth.

**Use each received revision as the application revision.** Future-only changes
would invalidate preparation, native proof and Project confirmations despite
unchanged executable targets. Relabeling existing item results would invent an
application history that never occurred.

**Add capability negotiation for each future field.** The selected rollout
requires a compatibility patch before a service adds fields, followed by clients
independently adopting functionality. Another negotiation layer does not repair
unknown-value loss in cache and state transitions. Existing mode/tool negotiation
continues to govern its own outbound protocol.

## Consequences

The Worker can retain future configuration through restart and continue processing
known settings without claiming future settings are applied. Full source and its
known view consume memory, and schema 7 requires a binary that understands the new
cache. The [sudo cleanup decision](../feature/2026-11-17-worker-sudo-cleanup.md)
records the schema 6 to 7 recognition of that field as a new pending target. Individual raw source strings remain subject to runtime token limits even
though the aggregate checkpoint is streamed. Compatibility depends on actually
upgrading the older strict clients before new service fields appear; source merge
alone does not establish rollout. Recognition and execution of a new field remain
separate implementation work and must reconcile it as a new known target.
