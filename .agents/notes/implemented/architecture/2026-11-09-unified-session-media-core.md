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
Caller cancellation and decoder budget expiry remain context outcomes after the
decoder child joins; neither establishes invalid content or retires the original
verifying upload.
An entire input acquires its resources before dispatching; a later preparation
failure therefore cannot partially call the native provider. An uncertain native
result retains the original operation and its pins for observation.

Service-effective and Provider capability revisions are independently allocated.
Image authorization returns the effective capability snapshot alongside the
original operation and execution fence. The Controller matches the frozen
intent to its service revision and the current Provider to its providerRevision;
numeric equality between those counters establishes no relationship. The
snapshot does not rewrite the durable intent or its hash. Validated leases retain
the original MIME, bytes and full geometry so upload completion, authorization
and final native dispatch enforce the smaller effective limits. Asynchronous
preparation and native encoding end with another qualification check; a failed
image refuses the complete input. Historical reads remain independent of current
input qualification.

Resource reads require both Session access and a publishing reference. Message
references and committed archive closures permit shared reads; a private upload
requires its original actor and matching complete receipt. Operation, unknown,
native-resume and temporary archive pins retain bytes without granting access.
The authorized transaction checks references before I/O and again before
returning the bytes, so releasing a private reference cannot publish a late read.
Timeline reads likewise reauthorize ordinary historical access after file I/O and
decoding, retaining the original archive, ledger, file and delete-epoch identity.
A read lease protects physical storage rather than continued caller access.
Both checks use ordinary historical Session access rather than current-claim
browser admission. Published originals remain readable after a Task starts a new
claim, without transferring any authority over its new execution. Project and
parent-credential authorization, Bot deletion and the ordinary Task deletion
barrier apply at both checks; owner finalization never grants content access.

Releasing an unused complete upload retires its preparation pin and retains its
upload tombstone. A resource with no remaining references receives a durable
`gc_pending` marker under the Session lock. New references and covering leases
cannot revive it; existing exact reader and writer locks remain held through
physical cleanup and the final database confirmation. Its row remains until
those barriers finish, preserving both its content accounting and original identity
for reconciliation after cleanup errors or unknown commits. Cleanup sweeps the exact typed upload namespace,
not only paths with committed chunk rows: durable file publication can precede
a failed or uncertain chunk-row commit. A shared upload payload gate joins late
read-response writers before the durable sweep and final accounting decision.
A completed prepare error does not prove that no Controller files remain.
After reading the exact durable failed prepare, service release carries the
original spec. The Controller verifies that spec or writes a released tombstone
when no preparation exists, preventing delayed prepare replay. A successful
prepare keeps its original release body; an unknown prepare must first finish.
Preparation records name their random private path before creating or flushing
the file, so an error leaves a reclaimable identity rather than a rowless file.
Controller relay and local release share the temporary-storage classifier,
including lazy media-directory and budget-ledger initialization before a local
release can begin. Typed storage, metadata-capacity and local reader-busy failures
remain separate from identity, format, safety and native-use refusals. Only that release-specific response keeps the original durable service
request pending for cleanup under the same request ID, body and fence. Existing
terminal results remain immutable. Files and cleanup responsibility remain
through unknown, cancelled and failed cleanup until all barriers confirm completion.
Fixed upload expiry follows the same mechanism;
stopped archive preparation and sealing reconcile abandoned uploads without the
original client. Occupied operation, unknown, message, record and native-resume
references survive expiry. Historical upload queries retain the original actor
check without requiring the Task's current claim. Original operation queries
also use historical access, preserving unknown receipts without dispatching or
rewriting their original hashes and fences.

Media request rows retain bounded non-byte metadata and original request,
fence, chunk length and digest. Raw write bodies and read-response chunks live
only in the existing metered shared staging or committed blob storage. Short
transactions reserve their original identities and leases; file I/O and bounded
wire reconstruction happen outside those transactions, followed by revalidation.
Remote prepare/write/complete waits retain the upload and execution-lifetime
gates but release the outer transfer lease before starting the RPC. Write requests
refer to the existing metered chunk metadata; the relay obtains its own lease to
reconstruct bytes. This avoids two uploads consuming both Session slots while
each waits for a third slot. Local file access resumes only after fresh actor,
upload, receipt, fence, expiry and delete-epoch checks and new admission. Unknown
release results retain the conservative failure. Poll defers only capacity-blocked
write offers while preserving their identities and healthy text traffic; storage
and cleanup failures still propagate. Pending offers are filtered by the current
execution fence before the bounded selection. Connection epochs may rebind within
that generation; older unknown rows remain queryable.
The HTTP caller and Controller relay can therefore run on different instances.
A process-local mailbox cannot replace the shared durable source. Existing
payload-bearing rows are normalized through an exact expected-state write;
conflicts and unknown commits retain the original reconciliation identity.

New media tables keep identity and concurrency uniqueness in PostgreSQL while
protocol, state, expiry and rate policy belong to core. Account token buckets
retain a short owner/category row lock so a preparation can debit control and
prepare buckets together without replaying the authorized operation on a second
bucket conflict. Transfer lease admission retains its deployment lock because a single resource
version cannot cover concurrent occupancy across Sessions. The lock ends before I/O. Core supplies the lease occupancy limits as explicit
atomic conditions and decides capture transitions before a compare-and-swap of
the original request, receipt and validation facts. Source ACK retention likewise
belongs to core: original identity/hash checks precede its bounded prune and
admission decision; Store executes only the supplied cutoff and immutable insert.
Bot Session cleanup explicitly removes all
media children after joining leases and sweeping files; account rate state
survives that cleanup. Historical schema1/2 archive checks keep their existing
guarantees while schema3 relies on shared protocol and closure validation.

Historical display snapshots use the same complete resource-reference traversal
as archives, including Markdown, reasoning and retained bindings. They retain
descriptor closure while allowing unresolved projections; sealing remains an
archive-only requirement. Cached rows retain no original bytes or read authority.
Task history inspection uses that same traversal and retains its six-field
metadata preview, including the unified image name limit. Its schema3 reader
uses the original archive operation to read and authorize the separate timeline;
the shared archive permit and timeline read lease survive until response
delivery. No legacy archive copy or second competing archive admission is needed.

A source retry retains its capture, occurrence and locator while a new attempt
fences private staging and every subsequent commit. Its attempt and durable
Controller request commit together, so cancellation cannot strand an attempt
without a recoverable request. Controller decoding has one active slot
and a bounded queue of metadata requests; transient capacity rejection leaves
the original durable request pending rather than permanently poisoning that
identity. Observation reconciles existing work and does not create source IO.

The [archive model](../../../../docs/design/session-image-archives.md) writes one
manifest, one timeline and references to the same immutable resource store.
Legacy schema1 conversion belongs only at the data boundary. Its recoverable
migration preserves the original files and identities until the new closure has
been durably committed and read back. New writes do not generate a schema1 copy.
A zero-byte legacy resource retains its original ID, zero length and the empty
SHA-256. Its migration uses offset zero and an empty block, publishes an actual
durable empty original, and preserves that identity on exact retries. This narrow
legacy exception does not admit empty history or timeline files.
The unified resource reader also retrieves that original after migration. It
performs an authorized offset-zero read and verifies the returned identity,
empty bytes, EOF and digest. A descriptor alone cannot establish that an empty
original still exists or that the caller retains access to it.
Existing resources are reused only after descriptor and storage-identity checks
at migration preparation and commit. Sealing checks unavailable descriptors,
inline-content presence, blob fields and GC state. An exact stopped reset removes preparation
references while retaining its unavailable resource rows; resealing reuses an
identical row rather than inserting the same identity again. Inline conversion
compares the original row and clears its old bytes atomically; an external
original keeps its existing blob. A Controller without a local legacy receipt
first observes the committed archive. Its retained complete schema1 source,
including unreferenced resources and original bytes, must match the persisted
migration source hash and length before it can record the migrated receipt.
It does not create competing random file identities for that committed source.
The deleted-Task owner's status reconciliation can perform this conversion
under private finalization access, while public content readers retain the
ordinary deletion refusal.
An active connection handoff persists its latest target history epoch together
with the consumed grant. It retains acknowledged entries, source hashes and
file identities, allowing stopped synchronization to finish that verified
connection without accepting arbitrary epoch changes or reverting the chain.
The [actual content capacity decision](2026-11-13-session-actual-content-capacity.md)
replaces the former fixed archive and future-volume reservations.
Deletion closes admission and joins physical operations before its final sweep.
Ordinary media admission also reaps crash-orphaned leases across the deployment.
It ends the listing transaction before trying each original filesystem lock,
retains busy owners, and holds an acquired lock through confirmed deletion of
that exact lease. A timeout or uncertain commit never clears the counters.
The immutable archive barrier includes unresolved content-changing commands and
resource associations; unrelated unknown control receipts retain their original
identity without preventing publication of complete message history.

This decision replaces the separate wire and dual archive choices in the
[original protocol decision](2026-11-05-session-image-contracts.md) and
[original archive decision](2026-11-05-session-image-archives.md). Their native
identity, explicit failure, immutable original and no-replay rationale remains
applicable. Native image encoding, source scanning, preview and persistent image
drafts consume this foundation; their support profiles remain closed until their
own complete evidence exists.

## Alternatives

**Compare service and Provider revision numbers directly.** Their independent
publication histories can produce different valid counters or coincidentally
equal stale counters. Carrying the authorized association preserves both owners
without renumbering an immutable input intent.

**Rely on browser validation or generic decoder limits.** A model or policy can
change during upload, file acquisition or native encoding. Smaller qualified
limits must be enforced using the original decoded metadata at each admission
boundary; decoding the same immutable bytes again adds cost without proving the
current capability relationship.

**Keep separate image wire, provider sendInput and resource collections.** This
was the earlier design's response to strict old readers. It would also keep two
production representations and require identity and capacity reconciliation in
every downstream consumer. Revision negotiation and a bounded legacy data
adapter preserve old text without that duplication.

**Maintain a separate reference collector for historical display snapshots.** A
legacy-resource-only collector silently drops descriptors for unified images and
misses retained and reasoning bindings. Sharing the traversal keeps one closure
rule while allowing display snapshots to preserve unresolved history.

**Publish a deterministic schema1 archive copy for old readers.** This was the
earlier compatibility plan. It duplicates metadata, creates a second hash and
publication boundary and constrains current records to two complete projections.
Requiring the unified reader for new records keeps one authoritative closure.
The later actual content capacity decision replaces the former reservation.

**Store only local paths, or collect originals when a Session ends.** Sources may
change or disappear and a Controller may stop before that point. Upload and
capture success therefore include service persistence before archive sealing.

**Keep raw media chunks in completed database requests.** This makes relay
replay convenient but retains originals after upload release outside resource
accounting. Bounded metadata plus shared staging files preserves
cross-instance replay without a permanent database copy. A transient mailbox
alone cannot carry that durable responsibility across relay instances.

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
