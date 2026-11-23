# Publish and remove attachments

Read [Overview](daynight://manuals/overview.md) first, and [Write safety](daynight://manuals/write-safety.md) for every write. If path/link rules are unknown, also read [Attachment reads](daynight://manuals/attachment-reads.md). [Materials](daynight://manuals/materials.md) owns formal input/output sufficiency.

## Publication boundaries

`task_attachment_put` creates or overwrites one exact path. There is no attachment `ifVersion` or conditional overwrite token. Writes/removals change no Task status, properties, version or update time; an unchanged Task version does not freeze files. Coordinate concurrent writers and verify intended published bytes, MIME type, path, links and supporting resources. Existing private download snapshots retain only their own bytes.

Uploads, description replacement and status writes have no shared rollback. Retain each confirmed path/receipt and finish independent missing operations on original resources. Matching bytes or later absence establish current facts, not historical attribution of an uncertain write.

All writes require current credentials, Project write access and a live Task or Goal. Retained transfers bypass neither revoked access, deleted parents nor cleanup barriers.

## Complete inline files

Use `action: "inline"` with standard padded base64; decoded bytes are the file (`SGVsbG8K` represents exactly `Hello\n`). Empty files are allowed. The inline limit is 524,288 decoded bytes. A confirmed result has attachment metadata, `created` distinguishing creation/replacement and `writeOutcome: "confirmed"`.

Larger files use the upload lifecycle. Its complete-file limit is 5 MiB (5,242,880 bytes); chunking does not raise that limit.

## Retain one upload lifecycle

`begin` reserves a binding, `chunk` stages private bytes and `commit` publishes. Before begin, generate and retain a canonical UUID `transferId` with owner account, original authority (PAT or OAuth grant), Project, Task, exact path and content type. Reusing the ID with a different binding fails; another credential for the same account is not interchangeable. Continuations revalidate authority, credentials and access.

Begin returns `state: "receiving"`, `nextOffset: "0"`, `expiresAt` and maximum chunk size. Each new chunk is nonempty and at most 524,288 decoded bytes. Generate a distinct chunk UUID and retain its exact offset, bytes and digest. Append only at observed `nextOffset`; gaps, overlaps and out-of-order appends fail.

Offsets/counts are canonical nonnegative decimal strings without leading zeros, signs, fractions or exponent notation. Optional `sha256` is the lowercase 64-digit decoded-byte digest. A confirmed chunk receipt contains `chunkId`, `offset`, `acceptedBytes`, `nextOffset`, `sha256`, `receipt` and `expiresAt`.

`receipt: "accepted"` means staged bytes, not publication. While receiving, the same chunk ID/offset/size/digest can return `already_accepted`; different content conflicts. After a lost response, observe the original transfer before deciding continuation; do not choose a replacement ID or automatically replay.

Use `action: "status"` under the same Project/Task/transfer ID to observe state, offset, expiry and cleanup. After a commit attempt it may also return `operationId`, `totalBytes`, `sha256`, `writeOutcome` and confirmed metadata. Status does not promise lifetime extension.

Commit supplies `totalBytes` equal to confirmed accepted bytes and an optional whole-file hash. The service validates complete staged content before publication. A confirmed publication records operation ID, completion outcome and metadata; private cleanup may finish later.

## Observe completion and release private content

| State | Interpretation |
| --- | --- |
| `receiving` | Can accept a valid next chunk or complete commit request |
| `committing` | Publication began; retain its operation identity and observe |
| `committed` | A publication receipt exists; inspect completion and metadata |
| `unknown` | Publication unresolved; no inferred rollback or automatic replay |
| `failed` | Inspect recorded error and completion outcome before another decision |
| `cleanup_pending` / `closed` | Private content is being/is reclaimed; retained operation facts determine publication |

Commit is not automatically repeatable. After lost output, use status under the original binding. Repeated commit outside receiving returns current facts with a state error, not another publication. Failure may carry a confirmed outcome after publication if receipt/output/cleanup fails; retain that fact. Staged-chunk receipts and matching current bytes cannot manufacture a missing publication receipt.

`action: "abort"` requests private cleanup and may return pending cleanup; it does not roll back a possibly published attachment. Transfers have a one-hour initial idle and 24-hour hard lifetime. Activity cannot renew beyond the hard deadline or revive expired/cleanup-bound transfers; follow returned expiry. Retain needed receipts before record reclamation and release unused content after use.

## Remove one file

`task_attachment_remove` removes one exact registered `path`, never directories or supporting resources recursively. Confirmed results identify Project, Task and path with `removed: true`. Preserve references across the authorized material set. Failure may follow file side effects: retain completion facts, inspect current state and reassess without inferring rollback or attributing later absence to the unknown request.
