# Agent Note: Copilot interruption projection

Status: implemented

## Problem

Copilot can record a user abort after `assistant.turn_end` without recording
`tool.execution_complete` for the interrupted tool. The session becomes ready
for another input while the timeline and its archive retain a running tool.
Conversation display hides ordinary tools, leaving no visible interruption result.

## Decision

The shared live and history projection recognizes native `abort` with
`user_abort` or `user_initiated`. A top-level abort produces `turn_interrupted`
using its native event identity. Child aborts retain their owner in a separate
diagnostic and do not announce a top-level interruption.

Cancellation closes only running tools in the same owner and user interaction.
User messages establish interaction boundaries; steering and internal agentic
loop iterations retain the interaction. An iteration after idle or abort starts
a new scope. `assistant.turn_end` alone does not discard cancellation ownership.
A known direct `parentId` relationship establishes ordering first. Otherwise,
native timestamps locate late events relative to observed boundaries; equal or
missing timestamps retain arrival order. The provider reads history in order before
draining buffered live events, and deduplicates native event IDs.

Interrupted tools use the existing `failed` status and append an explicit
interruption explanation, preserving their identity, input, partial output and
truncation flag. No exit code or native completion is invented. Terminal tools
cannot return to running or have their result replaced by a late cancellation.
The journal owns revision increments for changed projected content.

The [protocol design](../../../../docs/design/task-session-protocol.md) owns
projection rules; [Session requirements](../../../../docs/spec/task-sessions.md)
own the visible result.

## Alternatives

**Close every running tool on abort.** This changes unrelated owners and older
interactions whose incomplete results are unknown.

**Use each assistant turn as the cancellation scope.** Copilot turns are
iterations of an agentic loop; this loses tools started earlier in the same
user interaction. Clearing ownership at turn end also misses the observed
turn-end-before-abort ordering.

**Hide running tools in the interface.** This leaves incorrect persisted data
and gives Conversation readers no interruption result.

## Consequences

Live projection and native history replay preserve the same cancellation
identity and tool result. Previously sealed archives remain immutable. Network
loss, session errors and abort reasons without evidence of user cancellation
do not become user interruption results. Arbitrarily missing or reordered
interaction boundaries cannot be reconstructed from timestamps alone; the
ordered provider history remains the source of interaction ownership.
