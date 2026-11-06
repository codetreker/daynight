# Agent Note: Claude interruption projection

Status: implemented

## Problem

Claude emits a user-shaped message when a response or tool execution is
interrupted. Rendering it as a user message attributes native bookkeeping to the
person and duplicates the confirmed interruption status. Native history has no
live interrupt receipt, so merely hiding the message also loses that status on
resume.

## Decision

The Claude adapter recognizes the two exact native interruption strings only
when the complete message contains one text block. It suppresses those messages
before input-observation callbacks. Live interruption still requires the existing
successful receipt, matching input UUID and aborted terminal reason. Historical
top-level markers become `turn_interrupted` directly. Child-agent markers do not
establish main-turn interruption.

The native synthetic message UUID supplies the same timeline entry identity for
live confirmation and history. The native generator yields this message before
its terminal result; receipt arrival can still precede or follow that result.
If no marker was observed, the existing result-based identity remains available.
This preserves upserts when a Controller restores native history.

The [protocol design](../../../../docs/design/task-session-protocol.md) owns the
projection and confirmation rules. The [Session requirements](../../../../docs/spec/task-sessions.md)
own the visible behavior.

## Alternatives

**Require `isSynthetic`.** SDK 0.3.247 exposes that optional field, but its native
interruption constructor does not set the metadata used to derive it. Its
`getSessionMessages` mapper also omits source metadata. Requiring the field would
leave the reported messages visible.

**Read raw transcript metadata.** A second native-history reader would couple the
adapter to another storage format solely to distinguish these two strings.
The SDK's existing history API and exact fixed-text recognition keep that
ownership unchanged.

**Hide the message in the Web UI.** This would leave false input-observation
callbacks and provider projection intact, and would require provider-specific
inference in every consumer.

## Consequences

Ordinary text, near matches, mixed content, tool results and assistant text retain
their existing projection. Exact user-authored copies of a standalone marker are
indistinguishable in SDK history; no broader matching is permitted. SDK upgrades
must revisit the fixed strings and native event ordering. Existing archive files
are not rewritten, and cancellation gates, queued-input handling and other
providers are unchanged.
