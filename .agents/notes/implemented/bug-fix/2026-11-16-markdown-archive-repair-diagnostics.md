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
`markdown_projection_failed` in the original cleanup or historical backfill
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

This extends the [typed archive waiting decision](2026-11-10-worker-recovery-evidence.md).
Receipt reconciliation remains first, and only actual archival and cleanup can
release retained resources. A successful condition probe does not manufacture a
receipt or mark a resource available.

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

**Change the frozen archive upload.** Replacing a source after an intent or
receipt exists would break reconciliation of earlier writes. Repair is admitted
before that boundary; existing archive operations keep their own original IDs.

## Consequences

The original claim, worktree, source and cleanup responsibility remain intact.
Probes read SQL projection markers without loading image resources. Invalid SQL
JSON or identity evidence remains a failure; it never proves repair. Legacy
journals retain their migration path and receive the same check during full
archival. The diagnostic addition requires coordinated service and client
delivery because older protocol readers reject unknown codes.

Successful repair does not establish why an older parser failed. Earlier records
collapsed startup, parse and identity failures into a generic error. New stable
diagnostics improve future evidence without reconstructing facts that were never
saved. Missing or changed sources remain explicit failures, and completed content
archival remains separate from Session lifecycle state.
