# Agent Note: Separate Session resource files from timeline content

Status: implemented

## Problem

Session resource descriptors and originals have persistence, integrity and
retention obligations independent of the timeline's candidate files. A
consumer that only needs resources should not depend on loading the full
timeline or on its storage representation. At the same time, deleting a
resource must not invalidate committed history or native input publications.

## Decision

`content/resource-files.ts` owns Session-bound descriptors, blobs, the shared
resource index, persistent pins, process-local leases, file validation and
resource budgets. It exposes the existing resource operations without owning
timeline entries. The production v9 pending-content composition retains timeline candidate
files and SQL visibility described in the [atomic publication
decision](2026-11-10-atomic-content-publication.md), and uses the resource
owner's descriptor byte count for its combined metadata budget. The independently
callable SQL composition uses the same file owner and guards; its current-row,
conversion and maintenance responsibilities belong to the
[SQL content decision](2026-11-12-session-sqlite-content-components.md).

The composition checks both committed timeline references and
`native_input_publication_images` in its synchronous read transaction before
delegating deletion. The resource owner then enforces lease and pin protection.
The composition supplies guarded deletion to its resource consumers, including
media import cleanup. The [source decision](2026-11-05-session-image-sources.md)
describes capture adoption. The directory layout, manifest binding, legacy
resource export and index format remain unchanged. Deletion retains private hard links to the descriptor and blob until file and
index updates are confirmed. If restoration fails, the retained links identify
the original evidence and the owner refuses further writes. Retained blob links
are charged to the physical budget, with links to the same inode counted once.

## Alternatives

**Move the timeline candidate implementation with resources.** This would
carry the v8-specific content mechanism into an owner whose consumers only
need resource files, coupling them to a storage representation and its full
timeline inventory.

**Put all deletion checks in the resource owner.** Timeline and publication
references belong to the content composition and its committed SQL snapshot.
Giving the file owner that responsibility would couple it to timeline storage
and risk bypassing the same reference rules in other compositions.

## Consequences

Resource-only consumers can reuse the file owner without loading timeline
content; resource descriptors remain a bounded in-memory map. The composition
must always supply guarded deletion to callers that can release resources.
Separating these responsibilities does not change the durable file format,
resource limits or existing v8 publication behavior.
