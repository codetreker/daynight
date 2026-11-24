# Agent Note: Atomic Task Sync Deletions

Status: implemented

## Problem

Deleting the latest visible task can remove a summary-derived watermark. Cached
hierarchy alone cannot identify every hidden descendant, and two overlapping
responses can share the same coverage while carrying different dependency or
removal facts. Applying one after the other must not restore deleted resources
or retire a newer history.

## Decision

Persist the authorized server coverage, local commit UUID and same-epoch removal
identities in schema 15. A task-sync ticket captures the commit revision in the
same transaction as summaries and execution bindings. History preparation and
application compare that revision before mutating any baseline. One transaction
removes summaries, details and Session catalogues, applies retained summaries
and authoritative dependency states, validates the complete graph, records
removals and advances coverage. Same-epoch coverage cannot decrease; empty active
sets may retain coverage. Repeated identical facts keep the revision and avoid
writes and broadcasts. Removal identity wins over a later old upsert.

The shared single-pass executor owns request, history observation and apply.
The graph hook owns polling, finite retries and page Session observations, and
checks the current durable revision before publishing. Scoped broadcasts are
hints: recipients re-read the manifest and removals under their existing access
before emitting targeted project/task events. Stored qualification and commit
checks are available to independent readers. Unbounded parent metadata deltas
remain merges; they do not replace the complete baseline.

A cold sync placeholder is a user baseline reset, not observed access denial.
An independent successful detail read keeps its opening qualification while
that placeholder is established; explicit denial still retires it.

Schema upgrade rebuilds refetchable task baselines while preserving account,
profile and compatible Session lifecycles. Same-epoch explicit replacement keeps
history generation and removal identities and records the difference from the
previous complete authorized set. A persisted rebuild revision survives later deltas, so delayed hints still expose that replacement. Real history replacement clears old removals.
The [sync design](../../../../docs/design/daynight-task-sync.md) owns mechanisms,
and the [deletion data decision](2026-11-24-task-sync-deletion-data.md) owns the
server snapshot. Deletion callers and the server still use their epoch rotation
contract; independent reader retirement and the settings UI have separate owners.

## Alternatives

**Compare only coverage.** Multiple commits can have equal timestamps, so this
cannot reject a stale dependency or deletion response.

**Infer descendants from the cached graph.** Missing or outdated topology cannot
prove which resources became invisible. Authorized server IDs supply that fact.

**Use a new server event sequence.** Retained deletion facts and physical-row
coverage already describe the window. A browser-local UUID orders baseline
acceptance without adding a wire sequence or retention service.

## Consequences

The cache retains deletion identities for the lifetime of the authorized epoch.
A stale request fails as a lifecycle conflict and ordinary graph reconciliation
may retry within its existing bounded owner. Full-set validation still costs
work proportional to the cached graph; this does not guarantee constant-time
application. Broadcasts cannot grant access or renew Session observations.
