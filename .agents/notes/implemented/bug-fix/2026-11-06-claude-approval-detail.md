# Agent Note: Readable Claude Approval Details

Status: implemented

## Problem

Claude approval cards serialized tool inputs as JSON. File content and edit
fragments appeared inside escaped strings, so actual line breaks and quotes were
hard to inspect before approving a write. Long file content could also consume
the display budget before later parameters affecting the operation appeared.

## Decision

The Claude Controller formats approval detail by tool while retaining the
original input for the native response. Commands remain exact; file operations
show paths, content, and ordered before/after fragments. Extra parameters and
empty values remain visible. File-level and per-edit metadata precede content,
and the existing Unicode-safe limit supplies an explicit truncation notice.
Unknown tools use readable key/value lines; malformed known shapes keep their
original readable representation instead of guessing at missing fields.
Formatted text is checked before truncation for NUL and unpaired surrogates;
those values retain the original JSON escaping so the interaction remains valid
under the Session text contract without changing native tool input.

The [Session requirements](../../../../docs/spec/task-sessions.md#基础会话交互)
and [protocol design](../../../../docs/design/task-session-protocol.md#claude-审批正文)
own the behavior and mechanism. This is separate from the
[Codex approval projection](2026-11-06-codex-approval-detail.md), which requires
native item correlation; Claude already supplies the full tool input to its
permission callback.

## Alternatives

**Keep pretty JSON.** Indentation separates parameters but cannot restore line
breaks inside string values; file and edit previews remain escaped.

**Format native JSON in the Web card.** The shared card would need to recognize
Claude tool schemas and distinguish them from other providers. Formatting at
the provider boundary preserves the existing plain-text protocol and renderer.

**Append extra parameters after file content.** This keeps each native object's
usual field order, but a long content value can hide `replace_all` and unknown
extensions behind the display limit. Metadata comes first instead.

## Consequences

Users can inspect ordinary command, write and edit requests without decoding
JSON strings. Approval actions, input identity, permission mode, expiry and
native confirmation retain their existing semantics. Nested objects and
malformed shapes may remain verbose or escaped; retaining unfamiliar data is
preferable to discarding it. Already recorded cards retain their stored detail.
The overall display limit still applies, and the truncation notice means the
request preview is incomplete rather than establishing that omitted text is safe.
