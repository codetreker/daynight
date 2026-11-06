# Agent Note: Readable Reasoning and Compact Tool Rows

Status: implemented

## Problem

Codex can emit reasoning items containing only opaque provider state, without
public summary or content. Projecting an empty text row gives the browser a
disclosure that opens onto nothing. Long shell invocations also wrap the tool
summary across several lines, obscuring the tool name and execution status.
On narrow screens, a repeated shell launcher can also consume the entire visible
summary, making distinct commands indistinguishable until expanded.

## Decision

Codex projection emits reasoning only when readable text is present. Empty
completion items preserve previously streamed text. The shared timeline also
filters persisted empty reasoning entries before creating their article wrappers,
so historical records do not leave blank spacing or empty disclosures.

Tool summaries keep a disclosure arrow, readable tool name, ellipsized input
and fixed status on one line. Expanded content retains the complete input and
raw output with bounded keyboard-accessible scrolling. Native tool identifiers
and result semantics remain unchanged; readable labels are presentation only.
The [session requirements](../../../../docs/spec/task-sessions.md) own the
visible behavior. This extends the
[reading decision](2026-10-28-session-reading-and-draft-ownership.md).

Command summaries remove one recognizable POSIX shell launcher around a single
literal argument. The display helper accepts `sh`, `bash`, `zsh`, `dash`
and `ksh`, optionally under `/bin/` or `/usr/bin/`, with `-c` or `-lc`. It decodes
single and double quoting, including adjacent literal fragments and backslash
escapes, without evaluating shell expansions. Simple unquoted words such as
`date` are also recognized. Unclosed quotes, dynamic outer
expansions, option-like arguments beginning with `-` or `+`, extra arguments,
operators and unsupported launchers keep their
original summary. This applies to Codex `commandExecution` text and selected
JSON `command` or `cmd` fields; other tool text and JSON field selection keep
their existing behavior. Whitespace normalization and the 180-character summary
limit follow decoding. Expanded input remains the original provider input.

## Alternatives

**Hide empty reasoning only in the producer.** Existing persisted entries would
still render empty shells. Consumer filtering makes the correction apply to
history without rewriting or deleting original records.

**Allow multi-line tool summaries.** This exposes more of a long command but
makes repeated tool rows harder to scan. Expansion already provides the complete
input, so the summary can reserve stable space for the name and status.

**Strip a launcher with a greedy regular expression.** Matching only the first
and last quote can hide trailing commands or misread escaped quote boundaries.
A small literal-word scanner preserves unsupported input instead of guessing.

**Normalize commands in provider projection.** Rewriting persisted input would
lose the exact invocation and affect expanded details. Display-only decoding
works for both live and archived entries without changing their source records.

## Consequences

Opaque native reasoning remains undisclosed rather than becoming invented text.
Visible summaries appear when the provider supplies them under the original
entry identity. The browser does not alter timeline sequence or cursor state.
Long tool names and inputs are visually truncated, and readers expand the row
to inspect complete input and output.
Recognizable launchers no longer displace the command itself on narrow screens.
Unsupported wrappers remain less compact; adding another known literal form
later only extends the display helper and its tests. A full shell evaluator and
approval-card presentation remain outside this decision.
