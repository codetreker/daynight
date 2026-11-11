# Read attachments and preserve references

Read this to list, inspect or consume attachment bytes. A Task read includes
neither its attachment inventory nor those bytes. Address files by authenticated
service, Project, Task and exact relative path. [Materials](daynight://manuals/materials.md)
owns content sufficiency; [Attachment writes](daynight://manuals/attachment-writes.md)
owns publication and removal.

## Exact paths and link bases

Paths preserve case and Unicode and use `/` separators. They are logical file
paths relative to one Task's attachment root, not filesystem paths, encoded URLs
or recursive upload directories. Send the unencoded logical path in JSON.
Leading/trailing slashes, empty or `.`/`..` segments, backslashes, controls and
absolute drive prefixes are invalid. `docs/design.md` is valid;
`docs//design.md`, `docs/../design.md` and `C:/design.md` are invalid.

New/replacement paths are limited to 1,024 Unicode code points including
separators; MIME types to 2,048 bytes. Path-based MCP reads additionally have a
4,096-byte UTF-8 limit. A file cannot also be another file's parent directory.
`path_conflict` is a real storage naming conflict; do not silently alter case or
required references to bypass it.

| Link location | Resolution base | Example |
| --- | --- | --- |
| Task description | Owning Task's attachment root | `[Design](docs/design.md)` resolves to `docs/design.md`. |
| Attachment `docs/design.md` | That file's directory, `docs/` | `[Constraints](constraints.md)` resolves to `docs/constraints.md`. |

Images use the same bases. Preserve supporting resource layout. For another
Task's material, identify its Project, Task, full path, applicable section and
purpose; a local relative path cannot cross Task roots. Keep shared inputs at
their owner and use verified application references when available, without
invented cross-Task URL schemes. Inventory entries and timestamps do not prove
that required content has been read.

## List, inspect or read complete small content

`task_attachment_list` returns one metadata page with `items` and `nextCursor`.
Entries contain `path`, `contentType`, decimal-string `sizeBytes`, `createdAt` and
`updatedAt`. Continue the returned cursor unchanged under the same Project and
Task until null or absent. Pages are not a cross-page content snapshot. Exact
limits are in the schema; the default is 50, range 1–100.

`task_attachment_read` defaults to `action: "inspect"`: it checks access and
returns `attachment`, `sizeBytes`, `contentRef` and `contentIncluded: false`, not
bytes. Select `action: "inline"` to consume the whole small file. `maxBytes` is a
byte ceiling, default 8,192, range 1–524,288. Oversize content fails with
`content_too_large`, never an undisclosed prefix.

The example is a `tools/call` params object with fictional IDs. Actual business
data appears under `structuredContent.data`.

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

| `format` | Interpretation |
| --- | --- |
| `auto` (default) | Valid text returns UTF-8; binary content returns `contentIncluded: false`, `requiresExplicitBinaryRead: true` and a reference. No omitted binary range has been consumed. |
| `text` | Requires valid UTF-8 and usable character boundaries; invalid content fails with `invalid_encoding`. |
| `base64` | Explicit exact-byte representation in `contentBase64`, with `encoding: "base64"`; decode before consuming or hashing. |

For `Hello\n`, inline text includes `sizeBytes: "6"`, `encoding: "utf8"`,
`text: "Hello\n"`, `eof: true` and SHA-256
`66a045b452102c59d840ec097d59d9467e13a3f34f6494e539ffd32c1bb35f18`.
The hash covers returned decoded bytes. Neither MIME type nor omitted binary
content establishes readability.

## Read larger content from one immutable snapshot

Use `open` → bounded `chunk` reads → `close`. A snapshot is a private immutable
copy: its ranges remain consistent after the original path is replaced.
Inspection followed by independent inline reading has no such guarantee.

Generate and retain a canonical UUID `transferId` before opening:

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

A readable open result contains transfer ID, `direction: "download"`,
`state: "readable"`, attachment metadata, decimal-string `totalBytes`, complete
snapshot `sha256`, `nextOffset: "0"`, `maxChunkBytes` and `expiresAt`; it does not
return the body. `preparing` is not readable completion. Observe the same binding
or report the unresolved state. Repeating open under the same binding observes
that transfer; it does not take a new snapshot of a replaced source.

The binding fixes owner account, original authority (PAT or OAuth grant), Project,
Task, direction and path. A different credential for the same account is not an
interchangeable authority. Each request checks current credential validity and
Project/Task access. Deleted parent resources, revoked access and established
cleanup barriers cannot be bypassed with a retained transfer.

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

Offsets and byte counts are canonical nonnegative decimal strings, retaining
exact integer digits: `"0"` is valid; `"00"`, `"+1"`, fractions and exponent
notation are not. `maxBytes` remains a JSON integer with inline's default/range.
Chunks return `offset`, `readBytes`, `nextOffset`, `totalBytes`, `eof`, encoding,
returned content, chunk `sha256` and expiry facts.

1. Start at `"0"`, decode each returned range and retain bytes in order.
2. Continue at returned `nextOffset`, not requested `maxBytes`: text ranges can
   shorten to avoid splitting a UTF-8 character.
3. Stop at `eof: true`; require final offset and assembled size equal `totalBytes`.
4. Hash all assembled bytes against open's whole-snapshot hash. A chunk hash
   verifies only that returned chunk.

If auto omits binary bytes, explicitly request base64 at the same offset. Text
from a mid-character offset or too-small ceiling can fail; use base64 for exact
arbitrary ranges. Beyond-total offsets are invalid; total-equal can return an
empty final range with `eof: true`.

## Close and retain completed content

Call `task_attachment_read` with `action: "close"`, the same Project/Task and
transfer ID. `cleanupState: "pending"` means cleanup is outstanding;
`"complete"` accompanies a closed transfer. Cleanup and expiry reclaim the
snapshot, not the original attachment.

Transfers have an initial one-hour idle lifetime and 24-hour hard lifetime.
Activity can renew idle expiry only up to the hard deadline; use returned
`expiresAt`. Expired or cleanup-bound transfers cannot be revived. Temporary
capacity or current permissions can prevent opening or continuation. Release
after use and retain complete verified bytes before declaring the input consumed;
an earlier snapshot only proves that snapshot's content, not a later live read.
