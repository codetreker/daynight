# Agent Note: Task Execution Timing Architecture

Status: implemented

## Problem

Creation and edit timestamps describe metadata events rather than an execution
interval. Execution duration needs trustworthy start and completion facts, while
running cards need a way to distinguish ordinary progress from work that may
need attention. A project-specific warning threshold also needs shared
persistence, authorization and concurrency semantics.

## Decision

The adopted [requirements](../../../../docs/spec/daynight-task-timing.md) and
[architecture](../../../../docs/design/daynight-task-timing.md) define one
execution interval per task, project-owned warning settings and a server-derived
display clock. Persistent task timing, project settings, their reader contracts
and task presentation form the implemented mechanism.

Task start and completion timestamps are nullable database facts written with
status and version under the existing project transaction. The latest genuine
entry into execution replaces the start. Migration leaves existing rows with
unknown timing. Completing a historical running task records its real end while
preserving its unknown start. Ordinary edits and same-state writes preserve the
interval. Statement time after acquiring the project lock avoids counting lock
waits as execution. The existing approval lifecycle stays intact.

Full tasks and graph nodes expose required nullable timestamps. CLI and Web
readers reject missing or malformed known fields without fabricating defaults;
JSON preserves explicit nulls and original timestamps. Human CLI output retains
its existing field choices.

Each graph supplies a database clock sample taken after its data reads. Web
polling stores the latest sample separately as `GraphSnapshot.observedAt`, while
content equality excludes the graph's sample. This preserves graph and index
identity on clock-only responses without freezing the sample consumed by future
clock clients. The existing local-wall-clock `receivedAt` label keeps its role.

Project settings occupy two project columns under the existing project lock
and a dedicated settings version. Migration gives existing projects the initial
60-minute threshold and version 1 without changing their historical timestamps.
Members read the saved setting; administrator writes recheck authorization after
the lock and compare version before no-op detection. Equal saves preserve version
and updatedAt; actual changes advance both. Create, read, list, graph and settings
PATCH responses expose the same complete Project resource.

CLI preserves nested settings versions through its existing raw-number decoding.
Web targets known Project envelopes using shared JSON source spans, preserving
versions above 2^53 without changing generic unknown-nested-field semantics or
requiring browser reviver source context. The persistent summary cache merges
Project settings by their exact version independently from task business versions,
so a settings-only change retains task references and the published GraphIndex.

The member-readable settings route exposes administrator save/cancel actions
with user/project-owned state and the shared foreground identity guard. Drafts
and confirmed refusals do not replace the saved Project. Unconfirmed PATCH
responses are reconciled by rereading Project and membership before another
mutation. Failed reconciliation keeps Save blocked and offers a read retry;
neither abort nor navigation proves rollback, and PATCH is never replayed
automatically. Role or resource loss clears private project state.

Each successful task-sync records observedAt and a monotonic receipt captured
before IDB application and index work. The project-owned clock advances that sample
through render commit delay with one visible-page ticker only while mounted
known-start running tasks subscribe. Completed durations use persisted endpoints
and subscribe only to settings metadata; unknown timing has no active subscription.
Hiding, the final running unsubscribe and unmount release timer/listener work.
Visibility return publishes the elapsed monotonic difference immediately, while
the existing guarded graph hook separately obtains a fresh database sample.

Known-start running tasks with `allowAgents=true` use strict unrounded threshold
comparison to drive amber icon/text warnings on graph cards and standalone rows.
Automatic-execution permission scopes the attention signal without changing
timing: tasks with `allowAgents=false` retain live duration and have no warning
text, styling or accessible warning meaning. The presentation preserves running
status, exact endpoint descriptions, existing accessible names, selection, external
dashes and card geometry. Time
updates stay local to consumers; the graph index and layout retain their identity.
Standalone visual timing does not become part of its button name, and tick
updates do not use live regions. Root-chain progress never claims an individual
execution interval as aggregate duration.

## Alternatives

**Derive timing from created or updated timestamps.** These fields describe
different events and ordinary edits change the latter. This would fabricate
history and make metadata changes alter execution duration.

**Accumulate attempts or store an event history.** Historical analysis would be
an additional capability with separate storage and output costs. The agreed
result needs only the latest interval; two nullable facts satisfy that result
without committing to an event-log format.

**Use browser wall time or one timer per card.** A wrong browser clock changes
warning decisions, while independent timers duplicate lifecycle work and can
couple ticks to graph updates. One monotonic project clock isolates that work.

**Store settings in a separate table.** The bounded project-owned values have
the same serialization and lifetime as the project. Separate storage adds a
join and another creation/migration path without a second ownership model.

**Deliver one combined runtime PR.** Timing persistence, project settings and
task presentation have independently verifiable outcomes. Serial delivery keeps
their review questions separate while reader updates accompany each resource
change, avoiding incompatible intermediate readers.

## Consequences

Historical starts remain unknown and cannot yield an inferred duration. The
graph's database sample and its paired monotonic Web receipt expose a clock
basis without per-card requests or a server worker. The display clock accounts
for post-receipt commit delay, retains network/parse sampling delay and reanchors
through existing polling; it does not claim network-latency compensation. Its timer ticks must
remain outside layout dependencies; future graph-cache changes must preserve the
separation between the latest sample and stable graph/index content.

Historical attempt reporting, automatic task recovery and a CLI settings
mutation command remain outside this delivery. They can be added independently:
the persisted interval does not claim history or control execution, and the
settings API is not tied to a browser-specific storage mechanism. Any future
attempt-history requirement needs its own durable representation and migration.
