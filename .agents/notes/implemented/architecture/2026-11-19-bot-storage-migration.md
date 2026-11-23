# Agent Note: Preserve Original Evidence During Bot Storage Migration

Status: implemented

## Problem

Existing assistants retain inventory in Worker SQLite and execution history in
public Controller directories. Moving only the database file loses committed
WAL content and associated resources. Rewriting launch paths can invalidate the
ticket hash in the journal and the Windows process-tree stop proof. A crash
between copying files and changing ownership can also leave two writable
locations or an apparently complete copy without a committed handoff.

## Decision

Migration is an explicit offline operation under the original Worker lock,
the Bot lock and the original Controller storage permit. Submitted executions
require verified original stopping evidence. Unknown process state refuses
migration; the operation does not terminate an active assistant.

The coordinator copies consistent SQLite snapshots and owned resources into
the Bot directory, preserving original tickets, intent, Session identifiers
and operation records. A durable manifest maps original evidence to its copied
physical location and records content digests. The original ticket remains
the authority for validating its journal and stopping evidence.

The source Worker database commits a migration receipt together with removal
of the migrated inventory and execution rows. The receipt binds the manifest
digest. Interrupted completion checks this receipt rather than interpreting
missing rows as proof of a successful commit. The schema version prevents old
Workers from reopening the source and recreating an obsolete writer.

Local transfer leaves remote recovery registration explicitly pending. Runtime
entry points refuse to use the copied original intent to start or control an
execution at its old paths. A dedicated reader validates the copied journal
against the original ticket and exposes retained history without starting a
Provider. Snapshot and timeline readers accept only validated shipped v16 or
current v17 schemas through an explicit read-only path. Recovery binding reads
use the same check. CLI upgrades preserve every protected copied byte and its
manifest digest; the strict current-writer reader remains unchanged. Native recovery material remains separately verified by its Provider;
timeline availability never establishes native resume capability.

The [runtime design](../../../../docs/design/worker-bot-runtime.md) owns the
mechanism and the [storage decision](2026-11-19-bot-owned-storage.md) owns the
dedicated location model.

## Alternatives

**Rewrite tickets and recompute their hashes.** A new hash would no longer
identify the original Windows stop proof. Retaining immutable evidence and a
separate location mapping avoids manufacturing execution provenance.

**Copy a live directory or only its SQLite main file.** The copy can mix resource
generations or omit committed WAL transactions. Writer exclusion and SQLite
snapshots retain the original committed state.

**Infer commit from absent source rows.** Missing data does not identify which
operation removed it. A transactionally bound receipt distinguishes the actual
migration commit from unrelated deletion or corruption.

**Upgrade a protected copied journal in place.** A numbered schema migration
changes the copied bytes and invalidates the committed manifest digest. Explicit
read-only access to the shipped compatible schema preserves both historical
readability and the original checksum authority.

## Consequences

Migration retains readable local history and stable identities independently
of the public Controller directory. It requires downtime and temporarily holds
both source and copied bytes. Original files are retained as evidence rather
than removed as an implicit cleanup step.

A completed local migration does not make the assistant runnable. The
[Worker reconciliation](2026-11-20-bot-worker-reconciliation.md) performs remote
recovery registration while preserving the execution fence; verified Provider
recovery material and an executable dedicated generation remain required.
The history reader does not add an offline browser history service. Unknown
stopping evidence remains a refusal even if all files appear readable.
