# Agent Note: Web Tag Color Projection

Status: implemented

## Problem

A project Tag needs the same color in every Web entry while Task references and
existing clients retain their established ID and name representation. A catalog
has no total size limit, and a deleted ID must not inherit another Tag's color.

## Decision

The Web shares an in-memory color projection per authenticated scope and project.
Visible and selected IDs are resolved in batches of at most 100. A complete round
uses one catalog epoch and publishes atomically; an epoch conflict permits one
new round. Missing IDs remain distinct from colors and failures. Task sync,
catalog reads and confirmed catalog writes invalidate the projection, with
cross-tab hints using the existing project cache channel. Scope lifecycle and
request generations fence stale results. Task references and IndexedDB formats
remain unchanged. The [Web design](../../../../docs/design/daynight-web.md#task-与-goal-标签展示)
owns presentation and refresh behavior.

## Alternatives

**Add color to Task references.** Existing strict clients and admitted Task
response sizes depend on the current representation; changing it would break
those contracts.

**Download the complete project catalog.** Catalog size is unbounded, and its
pages and usage counts have a different purpose from resolving visible IDs.

## Consequences

Readers make a separate bounded request and can show a color-read error even
when Task synchronization succeeds. Retaining the last successful projection
keeps content stable during background reads, while explicit missing and error
states avoid inventing a gray value. The [Task tag cache decision](2026-11-13-web-task-tag-cache.md)
continues to own identity and name admission.
