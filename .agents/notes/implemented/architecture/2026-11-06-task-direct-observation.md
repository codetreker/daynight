# Agent Note: Task Detail Observation Without a Project Graph

Status: implemented

## Problem

A complete, authorized Task can be newer than project synchronization or remain readable while a project graph fails or exceeds its display capacity. Detail reading and writes still need a current identity, exact version and history, even when no complete summary is available. The same task ID and version can recur after history replacement.

## Decision

Task GET reads permission, the complete Task and its project epoch in one read-only repeatable-read snapshot. A successful response retains the complete Task body and publishes `Daynight-Task-Epoch` only after that snapshot finishes. The Web validates the principal, body and epoch and binds a direct observation to its user fence, project revision, history, task, opening and request. It keeps this receipt in memory for that opening and observes epoch through the same history owner as project synchronization.

A conflicting manifest observed from another tab fences existing receipts and prompts a live reread; it does not establish which epoch is newer. Conflicting overlapping network observations likewise require a fresh confirmation: request start order does not establish snapshot order. Only a confirmed observation can retire an epoch. Pending writes remain fenced through this uncertainty until their history is confirmed or retired; closing a view transfers an accepted write to its original owner without granting it a later opening's authority. An ordinary identity check retains the displayed detail, menus, confirmations, Session recording and local input while the authentication gate continues to block new requests and writes. If identity verification interrupts admission of an already received write or catalogue result, the same owner retries only the read-only qualification after recovery. A catalogue result remains bound to its original opening and history while current assignment eligibility is rechecked, so a newer Task receipt alone does not discard it. The [local mutation settlement decision](2026-11-11-task-mutation-local-settlement.md) separates the operation promise and busy state from this read-only admission while preserving the original publication fences.

Earlier decisions established [persistent summaries](../../archived/architecture/2026-10-24-persistent-task-summary-cache.md), [local summary display](../../archived/architecture/2026-10-27-project-cache-display.md) and [timestamp-window detail caching](../../archived/architecture/2026-10-24-task-view-timestamp-window.md). The [standalone detail decision](../../archived/architecture/2026-10-24-standalone-task-detail.md) originally required a project graph; this decision adds direct admission. Summary-backed details and writes still require this mount's successful project sync and matching live detail admission. Direct observations do not fabricate or persist summaries. Successful writes retain their confirmation and committed version until a subsequent live observation reaches that floor. Steps use the source's verified parent version. History replacement retires the graph, detail and reading resources before a bounded fresh read. Task not_found withdraws the detail and triggers project access revalidation instead of inferring project denial from a missing task.

Direct Session discovery and attachment browsing share one opening-bound history owner, so a change of claim cannot revive a separately retained denial or duplicate the same read. A completed claim resolves its own Session without automatically scanning older records. Returning to a visible direct detail immediately refreshes its Task, allowing lifecycle changes to update the Session view.

The [requirements](../../../../docs/spec/daynight-task-sync.md) and [design](../../../../docs/design/daynight-task-sync.md) own the current contracts.

## Alternatives

**Require a successful project graph.** This makes valid tasks inaccessible while synchronization fails or has not yet included a new Task. At the original decision, graph-size limits added another refusal; the [canonical batch-read decision](../simplification/2026-11-09-task-canonical-batch-reads.md) removes that capacity check while direct detail observation remains independent of graph availability.

**Treat search hits or fabricated summaries as admission.** Neither proves the complete current Task or its history; relaxing persistent summary validation would also weaken normal cached details.

**Read the epoch in a second transaction.** A concurrent history replacement could pair a Task from one snapshot with another epoch and admit old content as current.

## Consequences

A direct opening remains usable independently of graph availability, but requires its own live reads and in-memory lifecycle. Conflicting observations can require an additional bounded read. Relations, people and Session records need source-aware reads; a local task-chain graph does not include every external successor. No atomic history compare-and-swap is added to write APIs, so existing authorization, version checks and unknown-outcome reconciliation remain essential.
