# Agent Note: Display Local Project Summaries During Synchronization

Status: implemented

## Problem

Opening a project waits for task-sync even when its complete task summaries are
already stored locally. Network latency therefore delays navigation without
adding information needed to render those summaries. The existing successful
sync requirement also supplies detail admission and the execution clock, which
must keep their actual response provenance.

## Decision

After identity verification, the project hook publishes a complete validated
local summary snapshot before awaiting task-sync. It reuses the existing
manifest, user fence, project generation and graph validation. A valid empty
project renders normally. Missing or invalid baselines retain the initial
loading path; storage errors remain visible. Background synchronization replaces
the snapshot atomically, and recoverable errors retain its content with Retry.
Trusted access withdrawal clears content and disables local previews for that
project within the authenticated scope until successful online recovery.
`canPreviewProject` derives eligibility from the existing retired-generation
record and online authorization set. The hook checks it before reading disk and
again before publishing, so a withdrawal during hydration cannot reveal content.
Navigation or remounting within that scope preserves the denial. Generation-checked
cleanup can retain a newer durable set without authorizing its display; ordinary
hints, failed Retry and polling cannot restore eligibility. Successful `applySync`
restores online authorization while retaining old-generation fences.

Local summary publication has revision zero, null server observation and null
successful receipt time. It does not add the project to the scope's online
authorization set. Detail bodies and task writes continue to require this
mount's successful project sync and their existing live detail read rules.
A local-only detail mount leaves shared session observation unchanged: its
visibility gate cannot cancel an already accepted operation still preparing in
the same authorized history. Its own first live receipt still requires an
opening GET before new writes.
The authenticated scope also participates in visible-state identity, preventing
a replacement user from observing the previous user's same-project snapshot.

A local wall-time sample and monotonic anchor serve only provisional recent
classification in Overview and Task list. Actual task-sync supplies the server
sample and replaces that time basis. The [recent browsing
decision](../feature/2026-10-27-recent-task-pages.md) shares this current-time basis
across both sections while interpreting calendar boundaries in the browser's
local time zone. Running execution durations and possible-stall
warnings remain absent until that sample arrives; completed durations still use
persisted endpoints. Local time never advances synchronization coverage or
represents a successful refresh.

This partially supersedes the publication policy in the
[persistent summary cache decision](2026-10-24-persistent-task-summary-cache.md).
Its storage, transaction and invalidation mechanisms remain the owners of the
validated local data. The [requirements](../../../../docs/spec/daynight-task-sync.md)
and [design](../../../../docs/design/daynight-task-sync.md) own current behavior
and integration details.

## Alternatives

**Keep every summary behind the first online response.** This couples rendering
to network latency even after the local collection has passed validation, and
prevents the requested immediate display.

**Treat a cached snapshot as a successful sync.** That would grant detail
admission without the required response and fabricate a server clock from
durable metadata. Separating local summary visibility preserves those owners.

**Hide recent standalone progress until online synchronization.** This would
omit existing overview content while the rest of the cached project renders.
Provisional local classification keeps that content available with an explicit
transition to the server time basis.

## Consequences

Cached projects become readable during a slow or failed sync. Their summaries
can be stale until the background response arrives, and provisional recent
classification can reflect device-clock skew. Identity verification remains
required, so this does not introduce an offline authenticated application shell.

The page and clock model explicitly represent the absence of an online receipt.
Validation covers publication before a held response, background updates and
failure, empty and missing caches, scope changes, trusted revocation and timing
without a server sample. Two-scope races retain a newer durable generation across
a captured older-generation denial while keeping it hidden during failed recovery,
navigation and remounts; successful online synchronization restores publication. Native-browser verification remains necessary for
IndexedDB persistence across page reloads.
