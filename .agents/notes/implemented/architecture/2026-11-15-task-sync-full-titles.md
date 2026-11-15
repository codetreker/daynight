# Agent Note: Complete Titles in Project Task Synchronization

Status: implemented

## Problem

Project lists and personal tasks need to identify the same Task by its actual
full title. The project synchronization projection exposed only the first 160
Unicode characters, so distinct titles with the same prefix looked identical
and long titles could not be displayed without another read. Historical titles
can exceed the current write limit, which therefore cannot bound read output.

## Decision

Task synchronization returns the full `title` with the existing preview and
truncation marker for each Task and Goal in a snapshot or delta. All three are
read from the same database snapshot. The browser requires and persists the
full title, compares it as intrinsic task content and uses it for the existing
ordinary project task rows. Detail consistency and confirmed write view projections
carry the full title with its exact version and project epoch without advancing
the durable synchronization watermark. Older sync results
cannot replace a newer accepted task version. Existing graph and other preview
consumers retain their preview contract.

The IndexedDB schema upgrade clears incompatible project manifests, summaries
and details atomically, then obtains a full snapshot under the existing identity,
generation and Session history rules. It does not infer a title from a preview.
The [synchronization requirements](../../../../docs/spec/daynight-task-sync.md)
and [design](../../../../docs/design/daynight-task-sync.md) own the protocol,
recovery and lifecycle contracts.

This extends the projection of the historical [window synchronization decision](../../archived/architecture/2026-10-24-task-summary-window-api.md)
and the [persistent summary cache decision](../../archived/architecture/2026-10-24-persistent-task-summary-cache.md)
without changing their selection and identity boundaries. The [tag cache decision](2026-11-13-web-task-tag-cache.md)
records the earlier schema rebuild for mandatory tag references.

## Alternatives

**Keep previews in project rows.** Distinct titles with the same first 160
characters remain indistinguishable and project and personal lists represent
the same Task differently.

**Fetch each complete title from task detail.** A list would require a separate
request per task, with extra latency and failure paths, and its reads would not
share the synchronization snapshot.

**Infer missing titles from cached previews or the current write limit.** A
truncated preview cannot recover its suffix, and historical titles need not
obey the current write limit. Either approach would fabricate or lose data.

## Consequences

Project rows can render complete real titles and detect suffix-only changes
without per-row HTTP requests. Response size, decoding and IndexedDB storage now
scale with the full titles in the selected records. Natural network, decoding and
storage failures remain visible; no new read limit or silent truncation bounds
these costs. The schema rebuild requires a fresh snapshot after upgrade. The
shared Task row and personal-list changes remain separate consumers of these
facts.
