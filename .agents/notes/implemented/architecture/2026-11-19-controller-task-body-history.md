# Agent Note: Controller Task Body History Activation

Status: implemented

## Problem

Task message history must survive tool output larger than its retained body
allowance. Tools still need stable identities, revisions, pending approvals,
reconnect reconstruction and image resources during execution. The shared
timeline could not discard those details without losing live behavior, and
discarding them before confirmed archival would remove recovery evidence.

## Decision

Journal v15 persists the execution's `legacy` or `task_body` policy and adds
separate online entry and total tables. New claim-bound Task executions select
body history. Migration and recovery preserve existing policies and rows; Test
and Bot executions do not acquire Task semantics from their shared execution
identifier. This activates the production path deliberately left separate by the
[save policy decision](2026-11-18-timeline-history-policy.md).

Message bodies retain the original table and 128 MiB allowance. Other entries
use an independent 512 MiB current-content allowance; each table permits 100000
entries. Combined reads preserve global sequence, kind and revision ownership
for live pages, inspection, approvals and reconnect snapshots. Exceeding an
online limit rejects publication rather than truncating output or evicting
control state. Markdown source storage has its own 512 MiB allowance for body
executions. These logical limits do not bound total database or media disk use.

Synchronization and freezing consume only the retained body table and its
resource closure. Source acknowledgements continue to cover the full event
stream. The producer uses the negotiated
[body history protocol](2026-11-19-task-body-history-protocol.md), retains a frozen
sync intent across unknown transport results, and carries cumulative image
positions without tool text. Unsupported services produce an explicit upgrade
error; they do not cause the producer to relabel full history or switch policy.

Local online content retirement requires the original stopped execution, an
acknowledged source tail and a durable archive receipt already reconciled with
the service. It removes online rows and their image/Markdown state, then releases
resources that neither body history nor native input publication retains.
Existing pins and leases prevent premature file deletion. Partial cleanup
retains its real committed state and retries remaining files; archive success
and local cleanup success remain distinct facts. The
[SQLite content design](../../../../docs/design/session-sqlite-content.md) owns
the precise transaction, receipt, compaction and checkpoint conditions.

The resource owner's existing index durably records the exact deletion backups
that no longer serve recovery. Cleanup consumes this inventory across reopen,
verifies file ownership and type, and clears it only after deletion and directory
sync succeed. Ordinary resource release reports its logical commit even if
subsequent backup cleanup warns and remains pending. Stopped online retirement
requires strict backup cleanup before compaction and completion; failure retains
the confirmed archive receipt and the remaining cleanup obligation. Backups
still needed after failed resource restoration remain recovery evidence.

Publishing the new resource inventory is the final logical release commit,
after original-file deletion and directory sync. If publication throws, the
owner reads the actual index before deciding whether rollback is valid. An
exact new inventory preserves the committed deletion; a confirmed old inventory
permits restoration. Unknown or unexpected inventory preserves backups and
reports a recovery error. A visible new index does not prove its directory sync
succeeded and does not authorize destroying recovery backups. Cleanup reads and
validates the actual index, then requires a successful content-root directory
sync before deleting any registered backup. It performs this sync even with no
cleanup entries, so a prior index rename that cleared the inventory cannot bypass
durability on retry. Failure preserves backups and prevents strict retirement
completion. Deletion-directory sync and final durable index publication remain
required when consuming registered backups.

Strict cleanup also detects remaining `.delete` entries in the resource and blob
directories, even without an indexed cleanup inventory. A failed backup
registration after rollback therefore remains a completion blocker across
reopen. Detection grants no deletion authority: unregistered entries are
preserved and reported for recovery, never adopted or deleted by filename.
Ordinary release and budget admission retain best-effort cleanup warnings and
their existing commit and admission semantics.

## Alternatives

**Filter the original shared table.** This was deferred by the original save
policy decision because tools would lose revision, approval and reconnect state.
Separate online ownership resolves those constraints while keeping a single
journal and its existing execution transaction.

**Retain tools in body synchronization to authorize image capture.** This would
continue charging tool output to retained history and include it in archives.
The protocol's bounded cumulative image positions preserve capture authority
without transmitting the tool body.

**Apply Task policy to every upgraded journal.** Existing rows, frozen intents
and receipts describe full history. Reinterpreting them would change the meaning
of already accepted evidence. Migration therefore defaults to `legacy`; only
initial execution creation chooses the new Task policy.

**Keep pending backup cleanup only in memory.** Reopening would lose cleanup
ownership after a logically committed release. The existing durable index
preserves exact paths without introducing another manifest or inferring ownership
from a directory scan.

## Consequences

Large tools no longer consume retained message capacity, while live inspection
and pending operations retain their original ordering and content. Keeping two
tables requires cross-table identity checks and combined pagination; online
details still occupy bounded local space until archival is confirmed. The
cumulative image-position limit can reject additional positions even when a
tool revision no longer displays an earlier image.

The service must support the body protocol before a new Task Controller can
connect and synchronize. A confirmed archive can coexist with unfinished local
cleanup; cleanup failure must remain visible and retryable. Shared body images
and native input evidence are deliberately retained. This decision does not
enable Task retention deadlines, directory grouping, Bot cache eviction or
automatic deletion of native recovery material.
