# Agent Note: Separate Session resource file ownership

Status: implemented

## Problem

Controller Session resources must retain their private files, identity checks,
leases and pins while the timeline's storage mechanism can change independently.
The combined pending-content owner couples resource-only consumers to timeline
storage. Deleting a resource also requires knowledge of references outside the
resource files, so file ownership alone cannot decide whether deletion is safe.

## Decision

`controller/content/resource-files.ts` owns the Session-bound manifest, shared
resource index, descriptors, blobs, persistent pins and in-process leases. It
keeps the existing directory and durable formats, validates legacy resource
exports, and does not initialize or load timeline files. Resource-only consumers
use this owner; a resource facade supplies the guarded deletion operation to
media preparation.

`pending-content.ts` composes that owner with the v8 timeline. Before deleting a
resource, it checks current timeline references and
`native_input_publication_images` within the existing synchronous read
transaction. It combines descriptor bytes with timeline metadata accounting.
Candidate files and their SQLite visibility remain with the timeline owner, as
explained by the [atomic publication decision](2026-11-10-atomic-content-publication.md).
The [image contracts](../../../../docs/design/session-image-contracts.md#私有文件与-journal)
describe the resulting file and publication boundaries.

## Alternatives

**Keep resource operations inside pending-content.** Resource-only consumers and
future timeline storage would remain coupled to the v8 content owner, requiring
them to carry its candidate-file machinery to reuse resource storage.

**Move timeline candidates into the resource owner.** This would carry the
separate timeline publication mechanism into a module intended to survive a
storage replacement, and blur its transaction and reference responsibilities.

## Consequences

Existing resource formats and paths remain readable, and the same resource
implementation validates imports and legacy exports. The resource owner can be
reused without loading the timeline. It only enforces resource-local lease and
pin protection: every composition that deletes resources must also guard its
own references. The current composition retains that guard and the existing v8
candidate publication and metadata limits. Deletion retains hard-link backups
until its file and index updates succeed. Failed restoration reports the retained
paths; cleanup failures are retried by the same owner. A later process cannot
distinguish a retained backup from an active deletion, so it leaves the backup
in place and charges any distinct retained blob to the orphan budget.
