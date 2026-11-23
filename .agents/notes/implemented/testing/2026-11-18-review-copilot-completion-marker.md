# Agent Note: Review Copilot Completion Marker Tests

Status: implemented

## Problem

The review completion matrix starts both native skill discovery and a formal
Copilot review subprocess for each variation of the marker bytes. Those cases
exercise the same stdout transport and process cleanup while varying only the
final line, review number, or byte sequence. The
[Copilot session execution decision](../../archived/architecture/2026-10-17-copilot-session-execution.md)
records the completion marker as one condition of a completed attempt.

## Decision

Use the [production stdout Transform](../../../../packages/daynight/src/commands/review/adapters/copilot.ts)
and its exact marker predicate in a Node stream pipeline for the
[completion syntax matrix](../../../../packages/daynight/test/commands/review/copilot.test.ts).
Check the forwarded bytes, final line, and marker decision. Feed explicit byte
chunks when the UTF-8 decoder, CRLF handling, or end-of-stream flush is under
test.

Keep native subprocess cases for stdout and CRLF, stderr exclusion, exit
status, missing session history, invalid encoding, interrupted capture,
cancellation, and cleanup. The runner continues to combine the marker decision
with actual process, capture, and session evidence.

## Alternatives

**Keep the syntax matrix in native attempts.** This exercises process and log
handling on every row, repeating 22 skill discovery and review process launches
to vary the bytes entering the same Transform.

**Assert a stand-alone marker string check.** This would leave stream forwarding,
split decoder sequences, overflow, and end-of-stream handling outside the syntax
matrix.

## Consequences

The syntax matrix exercises the real parser and exact match without subprocess
or database setup. Native cases continue to verify that a marker only contributes
to completion after the attempt supplies the required process and session
evidence.
