# Publish and remove attachments

Read this for attachment writes, alongside the complete
[Write safety](daynight://manuals/write-safety.md) Resource. When paths or link
bases are not already understood, read
[Attachment reads](daynight://manuals/attachment-reads.md). Every operation uses
the authenticated service, Project, Task and exact logical path or retained
transfer binding. [Materials](daynight://manuals/materials.md) owns formal input
and output sufficiency.

## Publication, replacement and independent resources

`task_attachment_put` writes or replaces one path; an existing path is
overwritten. There is no attachment `ifVersion` or conditional overwrite token.
Attachment writes/removals do not change Task status, properties, version or
update time. Confirm the intended path/content, coordinate concurrent writers
and verify required published bytes; an unchanged Task version cannot freeze
files. Existing private snapshots continue to represent their own bytes only.

Separate uploads, description updates and status changes have no shared rollback.
Verify each required file's complete bytes, MIME type, path, links and supporting
resources. Preserve confirmed paths and receipts and finish missing independent
operations on the original resources. A matching file or later absence proves
current facts, not which uncertain write caused them.

Every write checks current credentials, Project write access and a live Task or
Goal. A retained private transfer cannot preserve revoked access or override a
deleted parent resource or its cleanup barrier.

## Put a small complete file inline

Examples are separate `tools/call` params objects with fictional IDs and bytes;
business data is under `structuredContent.data`. Replace identities with actual
observations and retain generated transfer/chunk IDs before submission.

```json
{
  "name": "task_attachment_put",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "action": "inline",
    "path": "notes/greeting.txt",
    "contentType": "text/plain; charset=utf-8",
    "contentBase64": "SGVsbG8K"
  }
}
```

Standard padded base64 publishes the decoded bytes: here exactly `Hello\n`.
Inline decoded content may be empty and is limited to 524,288 bytes. A confirmed
result contains attachment metadata, `created` (creation versus replacement)
and `writeOutcome: "confirmed"`. Inline content must be complete; use the
resumable lifecycle for a larger file, whose complete-file limit is 5 MiB
(5,242,880 bytes). Chunking does not increase that limit.

## Retain one upload lifecycle

`begin` reserves a binding, `chunk` stages private bytes, and `commit` publishes
the target. Generate a canonical `transferId` before begin and retain owner,
original authority (PAT or OAuth grant), Project, Task, exact path and content
type. Reusing its ID with another binding fails; another credential for the same
account is not interchangeable. All continuation requests revalidate authority,
credentials and current access.

```json
{
  "name": "task_attachment_put",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "action": "begin",
    "path": "notes/greeting.txt",
    "contentType": "text/plain; charset=utf-8",
    "transferId": "55555555-5555-4555-8555-555555555555"
  }
}
```

Begin returns `state: "receiving"`, `nextOffset: "0"`, `expiresAt` and maximum
chunk size. A new chunk is nonempty and at most 524,288 decoded bytes. Generate a
distinct chunk UUID and retain its exact offset, bytes and digest. Append only at
the observed `nextOffset`; gaps, overlaps and out-of-order appends fail.

```json
{
  "name": "task_attachment_put",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "action": "chunk",
    "transferId": "55555555-5555-4555-8555-555555555555",
    "chunkId": "66666666-6666-4666-8666-666666666666",
    "offset": "0",
    "contentBase64": "SGVsbG8K",
    "sha256": "66a045b452102c59d840ec097d59d9467e13a3f34f6494e539ffd32c1bb35f18"
  }
}
```

Offsets/counts are exact canonical nonnegative decimal strings, without leading
zeros, signs, fractions or exponent notation. Optional `sha256` is the lowercase
64-digit digest of decoded bytes. The confirmed receipt includes `chunkId`,
`offset`, `acceptedBytes`, `nextOffset`, `sha256`, `receipt` and `expiresAt`.
`receipt: "accepted"` identifies newly staged bytes, not publication. While
receiving, the same chunk ID/offset/size/digest can return `already_accepted`;
different content conflicts. A lost response does not justify a replacement ID
or automatic replay. Observe the original transfer before a continuation decision.

Use `action: "status"` with the same Project/Task/transfer ID to inspect actual
state, offset, expiry and cleanup. After a commit attempt it can also return
`operationId`, `totalBytes`, `sha256`, `writeOutcome` and confirmed metadata.
Status observation does not promise to extend lifetime.

```json
{
  "name": "task_attachment_put",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "action": "commit",
    "transferId": "55555555-5555-4555-8555-555555555555",
    "totalBytes": "6",
    "sha256": "66a045b452102c59d840ec097d59d9467e13a3f34f6494e539ffd32c1bb35f18"
  }
}
```

Commit requires total size equal to confirmed accepted bytes; its optional hash
is for the whole file, not one chunk. The service validates complete staged
content before publication. Confirmed publication records an operation ID,
completion outcome and attachment metadata; private cleanup can finish later.

## Observe publication and clean up

| State | Caller interpretation |
| --- | --- |
| `receiving` | Private content may accept a valid next chunk or complete commit request. |
| `committing` | Publication began; retain its operation identity and observe outcome. |
| `committed` | A publication receipt exists; inspect completion and metadata. |
| `unknown` | Publication is unresolved; neither rollback nor automatic replay is justified. |
| `failed` | Inspect the recorded error and outcome before a new decision. |
| `cleanup_pending` / `closed` | Private content is being reclaimed or reclaimed; retained operation facts determine publication. |

Commit is not automatically repeatable. After a lost response use status under
the original binding. A repeated commit after leaving receiving returns current
facts with a state error, not fresh publication. A failure can carry confirmed
write outcome after publication when receipt or cleanup work fails. Preserve it;
staged chunk receipts and matching current bytes cannot manufacture a lost
publication receipt.

`action: "abort"` with the same Project/Task/transfer ID requests private
cleanup and may return pending cleanup. It does not roll back an attachment that
may already be published. Transfers have an initial one-hour idle and 24-hour
hard lifetime; use actual returned expiry. Activity cannot renew beyond the hard
deadline or revive expired/cleanup-bound state. Retain needed receipts before
records are eventually reclaimed, and release unused content after use.

## Remove one file

`task_attachment_remove` accepts Project ID, Task ID and one exact registered
`path`. It never removes directories or supporting files recursively. A
confirmed result identifies the Project, Task and path with `removed: true`.
Keep references valid across the authorized material set. Failure may follow
file side effects: preserve reported completion, read current facts and make a
new decision without inferring rollback or attributing later absence to the
unknown request.
