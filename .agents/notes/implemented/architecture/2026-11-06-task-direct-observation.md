# Agent Note: Task Detail Observation Without a Project Graph

Status: implemented

## Problem

A complete, authorized Task can be newer than project synchronization or remain readable while a project graph fails or exceeds its display capacity. Detail reading and writes still need a current identity, exact version and history, even when no complete summary is available. The same task ID and version can recur after history replacement.

## Decision

Task GET reads permission, the complete Task and its project epoch in one read-only repeatable-read snapshot. A successful response retains the complete Task body and publishes `Daynight-Task-Epoch` only after that snapshot finishes. The Web validates the principal, body and epoch and binds a direct observation to its user fence, project revision, history, task, opening and request. It keeps this receipt in memory for that opening and observes epoch through the same history owner as project synchronization.

Summary-backed details retain the [persistent summary](2026-10-24-persistent-task-summary-cache.md), [local display](2026-10-27-project-cache-display.md) and [timestamp-window detail](2026-10-24-task-view-timestamp-window.md) rules. It updates the [standalone detail decision](2026-10-24-standalone-task-detail.md) to use the direct source. Direct observations do not fabricate or persist summaries. Successful writes retain their confirmation and committed version until a subsequent live observation reaches that floor. Steps use the source's verified parent version. History replacement retires the graph, detail and reading resources before a bounded fresh read. Task not_found withdraws the detail and triggers project access revalidation instead of inferring project denial from a missing task.

The [requirements](../../../../docs/spec/daynight-task-sync.md) and [design](../../../../docs/design/daynight-task-sync.md) own the current contracts.

## Alternatives

**Require a successful project graph.** This makes valid tasks inaccessible while synchronization fails, exceeds graph limits or has not yet included a new task.

**Treat search hits or fabricated summaries as admission.** Neither proves the complete current Task or its history; relaxing persistent summary validation would also weaken normal cached details.

**Read the epoch in a second transaction.** A concurrent history replacement could pair a Task from one snapshot with another epoch and admit old content as current.

## Consequences

A direct opening remains usable independently of graph availability, but requires its own live reads and in-memory lifecycle. Relations, people and Session records need source-aware reads; a local task-chain graph does not include every external successor. No atomic history compare-and-swap is added to write APIs, so existing authorization, version checks and unknown-outcome reconciliation remain essential.
