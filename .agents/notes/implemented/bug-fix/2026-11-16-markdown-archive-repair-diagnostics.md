# Agent Note: Preserve Markdown archive repair failures across retries

Status: implemented

## Problem

A stopped entry can retain complete text while its Markdown image analysis has
failed. The image occurrence set is then unknown. The archive validator rejects
the entry, but an unclassified failure repeats the same upload preparation every
minute and gives the operator no repair action.

## Decision

The [Worker archive policy](../../../../docs/design/daynight-worker.md) recognizes
non-null image projection errors before opening image resource files. It retains
`markdown_projection_failed` in the independent archive backfill
schedule and uses the existing 15-minute stopped-generation condition probe.
Worker SQLite migration 17 copies both schedule tables without changing their
owners, deadlines, failure counts or retry times, extending their code constraint.

Monitoring uses a fixed `markdown-projection-repair` diagnostic with the
`daynight worker repair-markdown --help` entry point. CLI, service and Web readers
share this exact code and message; arbitrary parser errors and source paths remain
local. The service must accept the diagnostic before a Worker reports it.

The [stopped repair mechanism](../../../../docs/design/session-image-archives.md#已停止执行的-markdown-图片投影修复)
reanalyzes preserved inputs under the original stopped execution identity. An
explicit command verifies the terminal owner and worktree before each local
write; the storage permit and snapshot comparison protect the publication.
Persisted per-entry plans retain the original failed projection and stable new
image identities. New source reads require explicit local repair authority and
the original directory root, rather than a fabricated native Read grant.

Saved-image reuse requires an unambiguous occurrence correspondence, including
its original range and revision lineage. Equal destinations can represent
different bytes at different positions; retaining every resource does not prove
that the current bindings display the right resource. The Session, stopped
journal and local execution must agree on a nonempty native identity. A missing
optional claim summary does not override those authoritative records, while a
conflicting known summary still prevents repair.

This extends the [typed archive waiting decision](2026-11-10-worker-recovery-evidence.md).
Receipt reconciliation remains first, and a successful condition probe does not
manufacture a receipt or mark a resource available. [Web archive independence](2026-11-16-web-archive-independent-cleanup.md) separates cleanup from archive repair.

## Alternatives

**Reuse the generic recovery diagnostic.** It preserves the old wire vocabulary
but cannot distinguish a failed Markdown analysis or direct the operator to the
supported repair command. Persisting a distinct reason also preserves the
explanation across Worker restarts.

**Retry the full archive automatically.** The existing upload path does not
reanalyze failed Markdown. Repetition costs I/O without changing the known
condition and obscures the missing repair step.

**Accept complete text as a complete archive.** Text completeness cannot prove
the image occurrence set. Clearing the error would silently turn unknown images
into an empty collection.

**Reuse the live capture coordinator after stopping.** Its native Read policy
and live writer fence no longer exist. Pretending those checks still pass would
conflate repair permission with Agent execution permission. Explicit repair
admits only verified ordinary files inside the original root; external sources
without a saved resource remain blocked.

**Change the frozen archive upload.** Replacing a source after a source-tail
batch, history checkpoint, intent or receipt exists would break reconciliation
of earlier writes. Repair is admitted before that boundary. The command selects
the original uploader for every persisted coordination state, including a tail
request whose result was lost before archive preparation; existing operations
keep their original IDs and bytes.

## Consequences

Controller archive sources and the original execution identity remain available.
The explicit repair command requires the retained original worktree; after normal
cleanup removes it, repair cannot read missing worktree sources or use a successor
checkout. Probes read SQL projection markers without loading image resources. Invalid SQL
JSON or identity evidence remains a failure; it never proves repair. Legacy
journals retain their migration path and receive the same check during full
archival. The diagnostic addition requires coordinated service and client
delivery because older protocol readers reject unknown codes.

Successful repair does not establish why an older parser failed. Earlier records
collapsed startup, parse and identity failures into a generic error. New stable
diagnostics improve future evidence without reconstructing facts that were never
saved. Missing or changed sources remain explicit failures, and completed content
archival remains separate from Session lifecycle state.
