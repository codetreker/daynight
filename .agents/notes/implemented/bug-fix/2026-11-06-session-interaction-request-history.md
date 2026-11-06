# Agent Note: Readable Historical Interaction Requests

Status: implemented

## Problem

Completed and expired interaction cards retained only their title and state.
Users could not inspect the original command, file request, question or form
even though the timeline still carried its definition. Conversation display
mode hides tool entries, making this loss especially significant when reviewing
what an agent requested.

## Decision

The shared interaction card retains a collapsed native disclosure after
resolution or expiry, including local response completion and archived history.
It renders only the original request definition: approval detail, questions and
options, or form field labels. It never renders local input values or response
controls. Long content wraps inside a bounded, named, keyboard-focusable region.
The existing timeline observers handle disclosure layout changes without a new
scroll policy. State and disclosure labels follow the page locale; native
titles remain unchanged.

The [requirements](../../../../docs/spec/task-sessions.md#基础会话交互) and
[design](../../../../docs/design/task-session-protocol.md#session-view-的阅读与输入状态)
own the observable behavior and component mechanism.

## Alternatives

**Reuse the answering form with disabled controls.** This would retain local
answers, including sensitive custom input, and suggest that a historical request
is still an actionable form. A separate definition-only rendering avoids both.

**Display every original request in full.** Native approval details can be long
JSON payloads. Default collapse preserves compact history while retaining access
to the complete request within its existing protocol budget.

## Consequences

Historical requests remain readable across providers without changing their
protocol, response gates or native permission semantics. The protocol does not
record response outcomes, so a resolved card cannot report approval, rejection
or an answer. Provider-specific formatting of raw approval detail remains with
the corresponding adapters. Disclosure state is local presentation state and
is not persisted as part of the interaction.
