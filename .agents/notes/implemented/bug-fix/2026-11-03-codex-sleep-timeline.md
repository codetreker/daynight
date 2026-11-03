# Agent Note: Project Codex Sleep as a Wait Tool

Status: implemented

## Problem

Codex emits native `sleep` items while an agent waits. Treating those items as
unsupported timeline errors makes normal waiting look like a failed operation
in Web Sessions and resumed history. A requested sleep duration also cannot
establish elapsed time because new input can end the wait early.

## Decision

The Codex projector maps sleep to the existing `tool_call` representation named
`clock.sleep`, following the
[reference projector](https://github.com/xuangong/agent-remote-control/blob/306fc4ccc8d3eba56ad5fbb30daafa4604ef865a/packages/agent-provider-codex/src/projector.ts#L407).
Native start and completion events retain the same entry identity, and history
uses the same completion projection. Finite positive durations describe the
requested upper bound in seconds; other values produce a plain wait label.
Output stays empty rather than inventing an elapsed duration or result.

The shared timeline renders the tool name, request and status with its existing
disclosure. No protocol kind, storage migration or browser-specific sleep state
is needed. The [session requirements](../../../../docs/spec/task-sessions.md)
and [provider design](../../../../docs/design/task-session-protocol.md) own the
current behavior.

## Alternatives

**Hide the unsupported-item error.** Suppressing it in the browser would conceal
normal waiting and leave the provider history incorrectly represented. The
provider must recognize the native item; diagnostics for other unknown kinds
remain visible.

**Introduce a dedicated sleep item and elapsed-time fields.** This would extend
the wire, archive and renderer for a wait already expressible as a tool call.
Requested duration is not elapsed time, and timing support is independent of
recognizing the wait lifecycle.

## Consequences

Live and newly projected historical waits are readable through existing tool
controls. Request duration remains honest when a wait ends early. Existing
immutable archives containing unsupported-item diagnostics are not rewritten;
the correction applies when native items pass through the updated projector.
