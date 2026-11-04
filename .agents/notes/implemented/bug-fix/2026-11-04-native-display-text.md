# Agent Note: Preserve invalid native text in the display projection

Status: implemented

## Problem

A successful native command can produce NUL or isolated UTF-16 surrogates. The
Session codec rejects these values before journal persistence. Controller treats
a failed durable projection as fatal, so displaying a tool result can stop an
otherwise healthy execution. Replaying the same native history repeats the
failure. Native deltas can also split a valid surrogate pair between callbacks.

## Decision

The shared runtime timeline callback creates a pure display copy before journal
validation. An explicit noninteractive text-field allowlist keeps authority-bearing
identities, interactions, responses and operation inputs outside conversion.
Malformed text is visibly annotated and escaped; backslashes in the same segment
are escaped to distinguish literal escape sequences from invalid code units.
Malformed message and reasoning bodies use literal fenced code blocks so the
Markdown consumer cannot collapse the doubled backslashes or interpret native
markup. Delimiters are chosen from retained content and count toward the display
budget. Well-formed text without NUL stays unchanged. See the
[design](../../../../docs/design/task-session-protocol.md#原生正文的显示转换)
for fields, budgets and persistence ownership.

Provider caches retain their own cumulative text, including temporarily unpaired
surrogates. A later delta can complete the pair without accumulating escaped
copies. Token-aware truncation bounds expansion, preserves existing tool
truncation and leaves the existing whole-entry wire fallback in place.

## Alternatives

**Relax the Session codec.** This changes assumptions shared by the server,
browser and stored formats, and accepts invalid authority-bearing strings as
well as display text. Keeping the strict codec confines the repair to its
actual source.

**Escape in provider length helpers.** Tool projections retain emitted entries
as incremental caches. Escaping there can accumulate escape sequences and
prevent a later low surrogate from completing its original high surrogate.

**Repair only at wire fallback.** That layer runs after strict source-event
validation, so malformed native text never reaches it.

**Drop malformed entries or continue after any persistence failure.** This hides
native output and real storage or identity defects. Only the known display-text
case is repaired; other failures remain visible through the existing fatal path.

## Consequences

Live and historical displays retain recognizable evidence within their budgets;
expanded output may be explicitly truncated and is not a lossless copy of the
full native record. Tests use synthetic malformed output, never business logs.
Protocol and database formats remain unchanged.

Recovery-budget persistence and remote execution summaries remain separate
responsibilities. This display repair does not restart existing executions or
repair arbitrary metadata, schemas or binary resources. Keeping those fields
outside the text allowlist preserves strict failure behavior and allows later
capabilities without changing native input ownership.
