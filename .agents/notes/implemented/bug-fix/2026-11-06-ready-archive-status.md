# Agent Note: Ready Archive Status

Status: implemented

## Problem

Completed Session views repeated the header status above the archived conversation.
The second status carried no new information and consumed limited reading space
on small screens. Other archive states still need body-level information because
the completed header does not explain why history is not available.

## Decision

The shared Session View renders the archive notice only while read-only history
is not ready. Readiness means the client has loaded and validated archive content,
not merely received a ready receipt. Task, Test and Bot views share this rule.
The header keeps its English status and accessible status role under the
[English Session labels decision](../../archived/bug-fix/2026-11-04-english-session-operation-labels.md).
The [archive lifecycle](../../archived/architecture/2026-10-30-session-file-archives.md) and
read-only control gates remain unchanged. The
[Session requirements](../../../../docs/spec/task-sessions.md#内容归属与结束后历史)
own the visible behavior.

## Alternatives

**Keep the repeated ready notice.** This preserves the old rendering but provides
no additional status or recovery action and reduces the conversation viewport.

## Consequences

Ready history gains the space previously occupied by the redundant notice.
Loading, pending, failed, unavailable and draining preparation retain their
existing body messages and refresh behavior. Display mode and fullscreen do not
change archive readiness or control permissions.
