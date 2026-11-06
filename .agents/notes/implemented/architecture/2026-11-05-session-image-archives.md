# Agent Note: Immutable Image Archives and Complete History Accounting

Status: implemented

## Problem

Paths and URLs cannot reproduce an earlier image after its source changes or the
Controller stops. Embedding every original in the existing 64 MiB JSON archive
also makes valid input impossible to retain: five 10 MiB images already exceed
that limit after Base64 encoding. Files written outside database transactions
create an additional crash and deletion problem: rejecting a late commit does
not prove that its physical writer has stopped.

## Decision

The repository publishes the adopted
[image archive design](../../../../docs/design/session-image-archives.md).
This implemented note records publication of the design, not implementation or
acceptance of image runtime behavior. Immutable Session-owned originals are
retained by explicit references. A schema3 manifest points to a sealed timeline,
verified original resources and a deterministic legacy representation. New
history and the complete legacy envelope each receive exact capacity accounting
before image admission.

The shared codec owns representation, traversal and encoded-size rules. The
archive consumer synchronizes complete history into bounded temporary files and
retains only identifiers, hashes, lengths, counts, references and source cutoffs
in the service database. Stop, capture settlement, sealing and ready publication
are distinct facts. Unknown commits and missing known originals cannot become
partial success. Explicit Test resume imports only a verified same-owner source
relation, reserves the complete target budget and creates independent target
originals without sending native input.

The existing [file archive decision](../../archived/architecture/2026-10-30-session-file-archives.md)
records the original archive trade-offs; the
[namespace decision](2026-11-05-session-archive-layout.md) owns the shipped
namespace behavior. The image design preserves the existing identity, stopped
writer, paired-backup and read-only boundaries. It does not rewrite legacy
records or repurpose the Herdr schema.

Every physical writer has a persistent lease covering its last write, rename,
fsync and handle close. Deletion closes admission, cancels and joins writers and
readers, then performs final cleanup before publishing completion. Lease expiry
alone cannot establish physical termination.

## Alternatives

**Increase one JSON limit and retain embedded Base64.** Opening and uploading a
record would still scale memory with all originals, while older readers reject
the new size. External originals preserve bounded metadata and legacy decoding.

**Keep source locators and collect at archive time.** Deleted or changed sources
cannot reconstruct accepted historical content. Successful collection must save
original bytes before the image becomes available.

**Copy every original for every archive.** This adds up to another 1 GiB of storage
and IO at termination, when already accepted content may no longer fit. References
within the same Session retain originals without duplicating the binary set.
Explicit new-Session resume still creates an independent target copy because its
ownership and deletion lifetime differ.

**Expire sent images or unknown operations by TTL.** Time cannot establish that
history or native input no longer depends on the bytes. Only terminal references
and physical writer/reader completion permit removal.

**Treat failed or timed-out collection as partial.** A commit may have succeeded,
and a known available blob may be damaged. Partial is restricted to definite
never-collected occurrences; unknown work remains recoverable and corruption
remains a failure.

## Consequences

An unresolved Markdown image projection error leaves the occurrence set unknown,
even when the full text and source sequence are present. It blocks archive
sealing and both complete and partial publication; an empty retained container
is not proof of an image-free document. The original text and references remain
available, and no synthetic occurrence may be invented to qualify as partial.
Successful bounded parsing of the same persisted text is a settling increment even when it proves there are no images.
After the prior sync reaches a confirmed terminal state, a new immutable sync
round carries the corrected projection under the same stopped identity and source
cutoff. The old ledger and pins remain until that round completes; recovery does
not require a WebSocket or permit new source IO. Without this increment, a cleared
local error could leave the service permanently unable to seal the archive.

The design requires reference and intent ledgers, exact dual representation
accounting, staged file transfer and recovery across file/database boundaries.
In return, valid accepted originals remain readable after Controller and source
shutdown without invoking native execution or source IO. The 64 MiB metadata
limits, 1 GiB/1000-resource budget and reserved physical space remain explicit.

Ready publication requires a verified closure and durable manifest, timeline,
legacy file and originals. Later corruption does not rewrite the immutable
manifest. Recovery requires the same bytes from a verified paired backup;
rollback disables new writes while retaining schema3 reads, legacy projection
and original-operation queries. An offline browser gallery, arbitrary record
copying and portable image export are outside this decision.
