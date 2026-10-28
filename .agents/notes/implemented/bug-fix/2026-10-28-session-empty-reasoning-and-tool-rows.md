# Agent Note: Readable Reasoning and Compact Tool Rows

Status: implemented

## Problem

Codex can emit reasoning items containing only opaque provider state, without
public summary or content. Projecting an empty text row gives the browser a
disclosure that opens onto nothing. Long shell invocations also wrap the tool
summary across several lines, obscuring the tool name and execution status.

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

## Alternatives

**Hide empty reasoning only in the producer.** Existing persisted entries would
still render empty shells. Consumer filtering makes the correction apply to
history without rewriting or deleting original records.

**Allow multi-line tool summaries.** This exposes more of a long command but
makes repeated tool rows harder to scan. Expansion already provides the complete
input, so the summary can reserve stable space for the name and status.

## Consequences

Opaque native reasoning remains undisclosed rather than becoming invented text.
Visible summaries appear when the provider supplies them under the original
entry identity. The browser does not alter timeline sequence or cursor state.
Long tool names and inputs are visually truncated, and readers expand the row
to inspect complete input and output.
