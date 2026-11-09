# Agent Note: One Session media core and external archive resources

Status: implemented

## Problem

Separate text and image protocols, provider methods, resource collections and
archive projections would require every consumer to reconcile two versions of
the same message. A successful upload also cannot imply durable history when its
only bytes remain in a Controller worktree. Existing records and uncertain native
operations must survive an upgrade without changing their identities or hashes.

## Decision

The [Session media contract](../../../../docs/design/session-image-contracts.md)
uses the existing native Session protocol with content revision 2. Text and images
share SessionInput, NativeProvider.send, SessionResource, operation intent and the
resource reader. Old Workers retain text behavior and explicitly require an
upgrade for media. Herdr retains its separate terminal protocol.

Controller preparations produce validated private files and controlled read
leases. Service publication requires independent complete decoding, matching
original length and SHA-256, durable file publication and a confirmed metadata
commit. Both callers execute the same pinned Node 24 and sharp validation build.
An entire input acquires its resources before dispatching; a later preparation
failure therefore cannot partially call the native provider. An uncertain native
result retains the original operation and its pins for observation.

A source retry retains its capture, occurrence and locator while a new attempt
fences private staging and every subsequent commit. Its reservation and durable
Controller request commit together, so cancellation cannot strand a reserved
attempt without a recoverable request. Controller decoding has one active slot
and a bounded queue of metadata requests; transient capacity rejection leaves
the original durable request pending rather than permanently poisoning that
identity. Observation reconciles existing work and does not create source IO.

The [archive model](../../../../docs/design/session-image-archives.md) writes one
manifest, one timeline and references to the same immutable resource store.
Legacy schema1 conversion belongs only at the data boundary. Its recoverable
migration preserves the original files and identities until the new closure has
been durably committed and read back. New writes do not generate a schema1 copy.
The 132 MiB archive reservation remains a conservative capacity commitment.
Deletion closes admission and joins physical operations before its final sweep.

This decision replaces the separate wire and dual archive choices in the
[original protocol decision](2026-11-05-session-image-contracts.md) and
[original archive decision](2026-11-05-session-image-archives.md). Their native
identity, explicit failure, immutable original and no-replay rationale remains
applicable. Native image encoding, source scanning, preview and persistent image
drafts consume this foundation; their support profiles remain closed until their
own complete evidence exists.

## Alternatives

**Keep separate image wire, provider sendInput and resource collections.** This
was the earlier design's response to strict old readers. It would also keep two
production representations and require identity and capacity reconciliation in
every downstream consumer. Revision negotiation and a bounded legacy data
adapter preserve old text without that duplication.

**Publish a deterministic schema1 archive copy for old readers.** This was the
earlier compatibility plan. It duplicates metadata, creates a second hash and
publication boundary and constrains current records to two complete projections.
Requiring the unified reader for new records keeps one authoritative closure;
the conservative reservation is retained rather than assuming immediate savings.

**Store only local paths, or collect originals when a Session ends.** Sources may
change or disappear and a Controller may stop before that point. Upload and
capture success therefore include service persistence before archive sealing.

**Release uncertain input or writer resources on TTL.** A timeout proves neither
native rejection nor physical process exit. References and actual cancellation
completion retain capacity longer but prevent replay and late writes after a
successful deletion.

## Consequences

The shared core makes consumer contracts consistent, at the cost of a required
reader revision for new media records and a recoverable legacy migration. File
and database commits remain separate facts, so uncertain outcomes must be read
back under the original identity. Independent decoders and private native copies
cost IO and storage. RSS observations describe the decoder build; they are not a
hard operating-system memory sandbox.

A complete protocol or storage test does not establish native model consumption,
physical-device interaction or production deployment. These evidence boundaries
remain explicit in the [acceptance specification](../../../../docs/spec/session-image-acceptance.md).

Archive publication performs blob I/O outside database transactions. A durable
lease and its exact filesystem lock let deletion close admission first and wait
for every prior I/O owner, while delete-epoch and authorization checks reject late
publication. The ordering guarantee is no resurrection or namespace residue;
Task and Bot rows remain available while an upload is stalled.
