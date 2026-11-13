# Agent Note: Task Tag Set Filters

Status: implemented

## Problem

Label selection must return complete pages of matching Task or Goal resources.
Filtering a bounded candidate page can omit later matches, and treating a deleted
or foreign label as an empty match conceals an invalid selection. Large legal
label sets also need continuation cursors within the existing transport limit.

## Decision

Ordinary, priority/ready and ranked search queries share a normalized tag filter.
REST and MCP list, ready and search inputs pass their selections to this shared
query path. The business layer canonicalizes, sorts and deduplicates UUIDs,
defaults the match mode to all,
and rejects incompatible untagged selection. Services resolve every requested
label in the same authorized repeatable-read snapshot used for selection. SQL
applies set membership before ordering and limits, preserving each resource's
own labels and existing scopes. The [server design](../../../../docs/design/daynight-server.md#列表与读取一致性)
owns the query mechanism.

CLI list, ready and search submit the same normalized UUID selection and match
mode to the server on each page. They expose untagged selection separately and
reject its combination with selected IDs. Grouped chain queries do not accept
these filters. The [CLI manual](../../../../packages/daynight/README.md#task-management)
owns the commands and result semantics.

Cursors bind a SHA-256 digest of the normalized set, match mode and untagged
selection. This preserves query identity while keeping cursor size independent
of the number of labels. It does not grant access or authenticate cursors.

## Alternatives

**Filter candidates in memory.** Applying the predicate after a limit produces
short pages and can omit ready resources beyond the original cap.

**Encode every selected UUID in the cursor.** A legal 24 KiB query can exceed the
16 KiB cursor limit after JSON and base64 encoding, preventing continuation.

**Treat unresolved labels as unmatched.** A deleted or cross-project selection
would look like a valid empty result and hide a condition requiring correction.

## Consequences

Filtered reads add one batch identity lookup for nonempty label sets in the
existing snapshot. SQL retains bounded result selection and page-level reference
loading. Queries gain no tag-count quota, and transport size limits remain
authoritative. Search retains its literal expression grammar and applies the set
filter independently of its Boolean branches. MCP search projects lean results
with tag references from the same ranked search rather than filtering a page in
the adapter. The CLI preserves existing page,
cursor and error handling rather than filtering a bounded local result set.
