# Attachment reads and references

Read [Overview](daynight://manuals/overview.md) first. Use this topic to list attachment metadata, resolve paths and consume complete bytes. A Task read includes neither attachment inventory nor bytes. [Attachment writes](daynight://manuals/attachment-writes.md) owns publication/removal; [Materials](daynight://manuals/materials.md) owns input sufficiency.

## Paths and link bases

Identify each file by authenticated service, Project, Task and complete case-sensitive relative path. Preserve Unicode and `/` separators. Send the unencoded logical path, not a filesystem path or URL. Leading/trailing slashes, empty or `.`/`..` segments, backslashes, controls and absolute drive prefixes are invalid. For example, `docs/design.md` is valid; `docs//design.md`, `docs/../design.md` and `C:/design.md` are invalid.

New/replacement paths allow at most 1,024 Unicode code points including separators; MIME types allow 2,048 bytes. Path-based MCP reads also impose a 4,096-byte UTF-8 limit. A file cannot be another file's parent directory. Treat `path_conflict` as a storage naming conflict; do not silently change case or required references.

| Reference location | Resolution base |
| --- | --- |
| Task description | Owning Task's attachment root: `[Design](docs/design.md)` selects `docs/design.md` |
| Attachment `docs/design.md` | Its directory: `[Constraints](constraints.md)` selects `docs/constraints.md` |

Images follow the same rules; preserve supporting layout. Relative references cannot cross Task roots. For another Task's material, identify Project, Task, complete path, applicable section and purpose; use verified application references when available, without inventing cross-Task URL schemes. Keep shared inputs at their owner. Inventory/timestamps do not establish content consumption.

## Inventory, inspection and inline content

`task_attachment_list` defaults to 50 entries, range 1–100. Results contain `items` and `nextCursor`; entries have `path`, `contentType`, decimal-string `sizeBytes`, `createdAt` and `updatedAt`. Continue the unchanged cursor under the same Project/Task until null or absent. Pages do not form a cross-page content snapshot.

`task_attachment_read` defaults to `action: "inspect"`, returning `attachment`, `sizeBytes`, `contentRef` and `contentIncluded: false` after access checks. It returns no bytes. `action: "inline"` reads the whole small file; `maxBytes` is a byte ceiling, default 8,192, range 1–524,288. Oversize content fails with `content_too_large`; no undisclosed prefix counts as success.

| Format | Meaning |
| --- | --- |
| `auto` (default) | Valid text returns UTF-8; binary returns `contentIncluded: false`, `requiresExplicitBinaryRead: true` and a reference, without consuming omitted bytes |
| `text` | Requires valid UTF-8 and usable character boundaries; otherwise `invalid_encoding` |
| `base64` | Exact bytes in `contentBase64`, `encoding: "base64"`; decode before consuming or hashing |

Inline results identify size, encoding, content, EOF and SHA-256 of returned decoded bytes. For example, `Hello\n` has `sizeBytes: "6"`, `encoding: "utf8"`, `text: "Hello\n"` and `eof: true`. MIME type alone does not establish readability.

## Immutable download lifecycle

Use `open` → bounded `chunk` reads → `close`. The private immutable snapshot stays consistent after the original path is replaced; independent inspect/inline requests have no such guarantee.

Generate and retain a canonical UUID `transferId` before open. Its binding fixes owner account, original authority (PAT or OAuth grant), Project, Task, direction and path. Another credential for the same account is not interchangeable. Every request rechecks current credential validity and access; retained transfers bypass neither parent deletion, revoked access nor cleanup barriers.

Readable open returns transfer ID, `direction: "download"`, `state: "readable"`, attachment metadata, decimal-string `totalBytes`, whole-snapshot `sha256`, `nextOffset: "0"`, `maxChunkBytes` and `expiresAt`, without body bytes. `preparing` is not readable completion: observe the same binding or retain the unresolved result. Repeating open with that binding observes the same transfer, not a fresh snapshot.

Request chunks with the same Project/Task/transfer ID, an exact `offset` and optional byte ceiling/format. Offsets and byte counts use canonical nonnegative decimal strings: `"0"` is valid; leading zeros, signs, fractions and exponent notation are invalid. `maxBytes` remains a JSON integer with inline's default/range. Results contain `offset`, `readBytes`, `nextOffset`, `totalBytes`, `eof`, encoding/content, chunk `sha256` and expiry facts.

1. Start at `"0"`; decode and retain returned ranges in order.
2. Continue at returned `nextOffset`, not requested ceiling: text ranges may shorten at UTF-8 boundaries.
3. Stop at `eof: true`; require final offset and assembled byte length equal `totalBytes`.
4. Verify the assembled SHA-256 against open's whole-snapshot hash; a chunk hash verifies only that chunk.

If auto omits binary, request base64 at the same offset. A mid-character text offset or too-small ceiling can fail; base64 supports exact arbitrary ranges. Beyond-total offsets are invalid; total-equal can return an empty EOF range.

Close with the same Project/Task/transfer ID. `cleanupState: "pending"` leaves cleanup outstanding; `"complete"` accompanies a closed transfer. Cleanup/expiry reclaim the snapshot, not the attachment. Transfers have a one-hour initial idle and 24-hour hard lifetime; activity can renew idle expiry only up to the hard deadline. Follow returned `expiresAt`; expired/cleanup-bound transfers cannot revive. Capacity or current permissions may prevent opening/continuation. Release after use and retain complete verified bytes before declaring consumption. An old snapshot proves only its own bytes.
