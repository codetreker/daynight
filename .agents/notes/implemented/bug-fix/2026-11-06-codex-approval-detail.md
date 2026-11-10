# Agent Note: Readable Codex Approval Details

Status: implemented

## Problem

Codex approval cards serialized the complete native request. Identity, timing,
and decision fields obscured the command and working directory, especially on
narrow screens. File approval requests contain no changes, so serializing the
request alone also omits the files that the user is being asked to approve.

## Decision

The Controller formats approval detail before emitting the existing interaction.
Commands retain their exact native spelling, including shell wrappers. File
requests use the matching live item from the same thread and turn; completed
items and ended turns release that display context. The formatter lists targets
and permission scope before diffs and applies the existing truncation limit.
Unknown extensions and malformed changes retain readable native content.

The [Session requirements](../../../../docs/spec/task-sessions.md#基础会话交互)
and [protocol design](../../../../docs/design/task-session-protocol.md#codex-审批正文)
own the behavior and mechanism. Historical disclosure continues to consume the
stored detail under the [existing decision](2026-11-06-session-interaction-request-history.md).

## Alternatives

**Format only the approval request.** This is sufficient for ordinary commands,
but native file approval requests carry an item reference rather than changes.
Matching the live item is necessary to show actual files without guessing.

**Parse native JSON in the Web card.** This couples the shared renderer to
Codex and cannot recover file data missing from the request. Provider-side
projection keeps the protocol and other providers unchanged.

## Consequences

Normal approvals prioritize the information needed for a decision while retaining
the original actions, native decision mapping, identity and confirmation rules.
Unknown formats may still be verbose: preserving unfamiliar permission details
is preferable to silently hiding them. Already recorded cards retain their
stored detail. This projection does not add a diff viewer or change Web layout.
