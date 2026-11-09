# Files and references

Attachments are files owned by one Task. Address them with the authenticated service, Project ID, Task ID and exact task-relative path. Reading a Task does not return its attachment inventory or file bytes. Use the attachment tools explicitly when a decision depends on a file's contents.

Examples below show the `params` object passed to MCP `tools/call`. The UUIDs, timestamps and file contents are fictional. Substitute IDs from actual observations, generate a fresh UUID when creating a transfer or chunk identity, and retain those identities for the operation. Successful business data is under `structuredContent.data`; a tool's short text response does not contain the complete result. See [Write safety](daynight://manuals/write-safety.md) for result and failure interpretation.

## Paths and reference resolution

Attachment paths preserve case and Unicode. Use the exact path returned by the service, with `/` between segments. Paths are relative to the owning Task's attachment root; they are not local filesystem paths, URLs or directories to upload recursively.

A valid path has no leading or trailing slash, empty segment, `.` or `..` segment, backslash, control character or absolute drive prefix. For example, `docs/design.md` and `images/diagram.png` are valid logical paths; `/docs/design.md`, `docs//design.md`, `docs/../design.md` and `C:/design.md` are invalid. Send the logical path in the JSON argument without URL-encoding its segments.

New or replacement paths are limited to 1,024 Unicode code points, including separators. Content types must be valid MIME values and at most 2,048 bytes. MCP path-based reads also have a 4,096-byte UTF-8 path limit. Use a file path for a file: a file cannot simultaneously be the parent directory of another attachment. Storage name and file/directory conflicts fail explicitly as `path_conflict`; do not silently change case or rename a required reference to bypass a conflict.

Relative links have two different bases:

| Content containing the link | Resolution base | Example |
| --- | --- | --- |
| Task description | That Task's attachment root | `[Design](docs/design.md)` identifies `docs/design.md` |
| Markdown attachment at `docs/design.md` | The attachment's directory, `docs/` | `[Constraints](constraints.md)` identifies `docs/constraints.md` |

Relative image references follow the same rules. Keep a document and its supporting resources at locations that preserve its real references, and read the resources needed to establish that they resolve. A resource's filename, inventory entry or timestamp is not proof that its required content has been read.

Keep shared inputs with their owning Task. For another Task's material, record its Project and Task identity, the full attachment path, applicable section and purpose. A relative path in one Task cannot identify a file in another Task. Use an actual verified application reference when one is available; do not invent cross-task URL schemes. See [Materials](daynight://manuals/materials.md) for formal content ownership.

## Find files and inspect metadata

`task_attachment_list` reads one metadata page. Its default `limit` is 50, with a range of 1–100. Pass a returned `nextCursor` unchanged on the next request under the same Project and Task; continue until it is null or absent. List pages are not a cross-page content snapshot.

```json
{
  "name": "task_attachment_list",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "limit": 50
  }
}
```

Each entry contains `path`, `contentType`, decimal-string `sizeBytes`, `createdAt` and `updatedAt`. The page uses `items` and `nextCursor`. Read a current file by its returned path rather than inferring a path from a Task title.

`task_attachment_read` defaults to `action: "inspect"` when the action is omitted. Inspection checks access and returns metadata, the opened object's size and a content reference. It does not return file bytes.

```json
{
  "name": "task_attachment_read",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "path": "notes/greeting.txt"
  }
}
```

The `data` fields include `attachment`, `sizeBytes`, `contentRef` and `contentIncluded: false`. A result containing only these fields establishes an inspected resource, not that the reader has consumed its content.

## Read a complete small file inline

Choose `action: "inline"` explicitly. `maxBytes` is a byte ceiling, defaults to 8,192 and can be 1–524,288. Inline reading returns the complete file or fails with `content_too_large`; it does not return an undisclosed prefix when the file exceeds that ceiling.

```json
{
  "name": "task_attachment_read",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "action": "inline",
    "path": "notes/greeting.txt",
    "format": "text",
    "maxBytes": 8192
  }
}
```

The six bytes `Hello\n` produce `sizeBytes: "6"`, `encoding: "utf8"`, `text: "Hello\n"`, `eof: true` and SHA-256 `66a045b452102c59d840ec097d59d9467e13a3f34f6494e539ffd32c1bb35f18`, together with attachment metadata.

`format` controls byte representation:

- `auto`, the default, returns UTF-8 text when the content is valid text. Binary content returns `contentIncluded: false`, `requiresExplicitBinaryRead: true` and a content reference.
- `text` requires valid UTF-8. Invalid bytes or an unsuitable character boundary fail with `invalid_encoding`.
- `base64` returns exact bytes in `contentBase64`, with `encoding: "base64"`. Select it explicitly for binary content or when reconstructing and hashing exact bytes.

Neither the MIME type nor an `auto` result that omitted binary bytes proves content readability. If binary bytes are necessary, explicitly request base64 and decode the returned field. The `sha256` accompanying returned content describes those decoded bytes.

## Read a larger file through one snapshot

Use `open`, bounded `chunk` reads and `close` to read a complete larger attachment. The snapshot is a private immutable copy. It allows ranges to be combined consistently even if the Task's file is later replaced. Inspection and a later independent inline read do not provide this cross-request guarantee.

### Open and retain the transfer identity

Supply a newly generated canonical UUID as `transferId`, and retain it before sending the request:

```json
{
  "name": "task_attachment_read",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "action": "open",
    "path": "notes/greeting.txt",
    "transferId": "33333333-3333-4333-8333-333333333333"
  }
}
```

A readable result includes `transferId`, `direction: "download"`, `state: "readable"`, `maxChunkBytes: 524288`, `expiresAt`, attachment metadata, decimal-string `totalBytes`, whole-snapshot `sha256` and `nextOffset: "0"`. `open` itself does not return the file body.

An existing transfer ID can only refer to the same account, authority, Project, Task, direction and original path binding. Repeating the same `open` observes that transfer; it does not create a fresh snapshot of a newly replaced source. If an observation reports `preparing`, it is not yet a readable snapshot. Observe the same binding or report the unresolved state; do not treat it as completed content.

The snapshot remains private to its authenticated owner and original authority: the original PAT, or the OAuth grant associated with the connection. Having another credential for the same account does not make an unrelated authority interchangeable. Each request checks current credential validity and Task access; a snapshot does not preserve revoked access.

### Read and assemble the returned ranges

```json
{
  "name": "task_attachment_read",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "action": "chunk",
    "transferId": "33333333-3333-4333-8333-333333333333",
    "offset": "0",
    "maxBytes": 65536,
    "format": "base64"
  }
}
```

Offsets and byte counts are canonical nonnegative decimal strings: `"0"` and `"65536"` are valid; `"00"`, `"+1"`, fractions and exponential notation are not. Preserve the digits as integers without rounding. `maxBytes` is a JSON integer with the same 1–524,288 range and 8,192 default as inline reading.

For the six-byte example, the following is a representative `structuredContent.data` result; `expiresAt` is supplied by the actual service:

```json
{
  "transferId": "33333333-3333-4333-8333-333333333333",
  "state": "readable",
  "offset": "0",
  "totalBytes": "6",
  "expiresAt": "2030-01-01T01:00:00Z",
  "encoding": "base64",
  "contentBase64": "SGVsbG8K",
  "sha256": "66a045b452102c59d840ec097d59d9467e13a3f34f6494e539ffd32c1bb35f18",
  "readBytes": "6",
  "nextOffset": "6",
  "eof": true
}
```

For a complete sequential read:

1. Start at offset `"0"` for the retained readable snapshot.
2. Decode each returned base64 range, or consume its returned text, and retain the bytes in order.
3. Use the returned `nextOffset` for the next request. Do not advance by the requested `maxBytes`: text reads may shorten a range to avoid splitting a UTF-8 character.
4. Continue until `eof: true`; verify that the final offset and assembled byte count equal `totalBytes`.
5. Compute SHA-256 over all assembled bytes and compare it with the whole-snapshot hash returned by `open`. A chunk's hash covers only that returned chunk.

If `auto` omits binary content, no content range has been consumed; explicitly request base64 for the same offset. `text` from a mid-character offset or with a byte ceiling too small for a complete character can fail; use base64 when exact arbitrary byte ranges are needed. An offset beyond `totalBytes` is invalid. An offset equal to the total can return an empty final range with `eof: true`.

### Close the snapshot

```json
{
  "name": "task_attachment_read",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "action": "close",
    "transferId": "33333333-3333-4333-8333-333333333333"
  }
}
```

`close` requests cleanup of the private snapshot. The response includes `state` and `cleanupState`; `cleanupState: "pending"` means cleanup has not completed, while `"complete"` accompanies a closed transfer. Closing or expiring a snapshot does not delete the original attachment.

Transfers initially have a one-hour idle lifetime and a 24-hour hard lifetime. Activity can renew the idle deadline only up to the hard deadline; use the actual returned `expiresAt`. Expired or cleanup-bound transfers cannot be revived into readable content. Release a snapshot after use rather than relying on expiry, and retain the full content before declaring its input consumed. Temporary capacity and current permissions can prevent opening or continuing a snapshot.

## Upload a complete small file inline

`task_attachment_put` writes or replaces one path. For a small file, pass the complete content as standard padded base64, with an explicit MIME type:

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

This publishes exactly the six bytes `Hello\n` when the write is confirmed. Inline decoded content can be empty, and is limited to 524,288 bytes. A confirmed result contains attachment metadata, `created` indicating creation versus replacement, and `writeOutcome: "confirmed"`.

Uploading a path that already exists replaces that file. There is no attachment `ifVersion` or conditional overwrite token in this tool. Task versions cannot protect a file against another writer. Confirm the intended path and input before replacing it, read back the bytes needed for verification, and coordinate concurrent writers outside any assumption that an unchanged Task version freezes the attachment.

## Upload a larger file with a retained lifecycle

A complete uploaded file is limited to 5 MiB (5,242,880 bytes). The resumable lifecycle accepts nonempty chunks of at most 512 KiB (524,288 decoded bytes); it does not increase the complete-file limit. `begin` reserves a binding, `chunk` stages bytes, and `commit` publishes the target attachment. A chunk receipt confirms private staging, not publication.

### Begin

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

Generate and retain the transfer ID before sending `begin`. It binds the upload to the authenticated owner, authority, Project, Task, exact path and content type. Reusing an ID with a different binding fails. A receiving result includes `state: "receiving"`, `nextOffset: "0"`, `expiresAt` and the supported maximum chunk size.

### Append a chunk at the observed offset

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

Generate a distinct chunk UUID for each new chunk and retain its original offset, bytes and digest. `sha256` is optional, but when supplied it must be the lowercase 64-digit SHA-256 of the decoded chunk. A new chunk must start at the observed `nextOffset`; gaps, overlap and out-of-order append fail.

A confirmed chunk result includes its `chunkId`, `offset`, decimal-string `acceptedBytes`, current `nextOffset`, `sha256`, `receipt` and `expiresAt`. `receipt: "accepted"` identifies newly accepted bytes. While the transfer is receiving, the same chunk identity with the same offset, size and digest can return `"already_accepted"`; a different payload under that identity conflicts. Do not generate a replacement chunk ID to guess around a lost response. Preserve the original operation and inspect its state before deciding on continuation.

For this example, the receipt has `acceptedBytes: "6"`, `nextOffset: "6"` and the digest above. The target attachment is still unpublished by this transfer.

### Observe status

```json
{
  "name": "task_attachment_put",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "action": "status",
    "transferId": "55555555-5555-4555-8555-555555555555"
  }
}
```

Use the returned state and facts rather than assuming an interrupted action rolled back. Status includes `nextOffset`, `expiresAt` and cleanup state; after a commit attempt it can also include `operationId`, `totalBytes`, `sha256`, `writeOutcome`, and confirmed attachment metadata. An observation does not promise to extend the transfer's lifetime.

### Commit the complete content

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

Commit requires `totalBytes` to equal the confirmed accepted byte count. Its optional `sha256` is the digest of the complete file, not one chunk. The service validates accepted content before attempting publication. A successful publication records an `operationId`, confirmed write outcome and attachment metadata; private content cleanup can finish separately.

Commit is not an automatically repeatable write. If a response is lost, inspect the same transfer with `status`, retain the original identifiers and classify what is actually known before deciding on another action. A repeated commit after the transfer leaves `receiving` reports its current facts with a state error; it does not perform a fresh publication.

| Observed upload state | Meaning for the caller |
| --- | --- |
| `receiving` | Private staged content can accept a valid next chunk or a complete commit request |
| `committing` | Publication has begun; retain the operation identity and observe its outcome |
| `committed` | Publication has a confirmed receipt; inspect `writeOutcome` and attachment facts |
| `unknown` | The attempted attachment write has an unresolved outcome; do not infer rollback or replay automatically |
| `failed` | The recorded attempt failed; inspect its outcome and error before planning any new action |
| `cleanup_pending` or `closed` | Private content is being reclaimed or has been reclaimed; retained operation facts still determine what was published |

An error can carry `writeOutcome: "confirmed"` when the attachment was published but later receipt or cleanup work failed. Conversely, a staged chunk receipt does not prove that the attachment exists. Interpret the returned outcome together with the error and retained operation facts. Read back the published file when content verification is required; finding matching bytes establishes current content and does not manufacture a lost publication receipt.

### Abort unused private content

```json
{
  "name": "task_attachment_put",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "action": "abort",
    "transferId": "55555555-5555-4555-8555-555555555555"
  }
}
```

Abort requests private transfer cleanup and can return pending cleanup. It is not a rollback operation for an attachment that may already have been published. The original authority, current credential and Task permission continue to be checked. Transfer expiry and the 24-hour hard lifetime bound continuation; preserve any receipt needed to understand the published result before private transfer records are eventually reclaimed.

## Remove a file

Removal targets one exact registered path:

```json
{
  "name": "task_attachment_remove",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "path": "notes/greeting.txt"
  }
}
```

A confirmed success reports the Project, Task, path and `removed: true`. Removal does not delete a directory or recursively remove related files. Keep required references valid when changing an authorized set of materials. A failed removal may follow file side effects; use its write outcome and read current facts before deciding again. A later absence is not, on its own, proof of which request removed a file.

## Multi-file work and verification

File writes, description updates, status changes and separate file uploads are independent operations. Uploading two files and then replacing a description has no cross-operation rollback. Preserve confirmed IDs and paths, finish the missing operations on the original resources, and report any required file that remains unreadable.

Attachment writes and removals do not change Task fields, properties, version or update timestamps. Re-read mutable inputs when their content matters; a matching inventory, unchanged Task version or earlier snapshot does not prove that a later source read will see the same file. A private snapshot gives a stable read of that snapshot only.

Before treating a document set as usable, verify its complete required bytes, MIME types, actual paths, links and supporting resources. See [Materials](daynight://manuals/materials.md) for content sufficiency, [Write safety](daynight://manuals/write-safety.md) for uncertain writes, and [Operation boundaries](daynight://manuals/operation-boundaries.md) for authorization and execution responsibilities.
