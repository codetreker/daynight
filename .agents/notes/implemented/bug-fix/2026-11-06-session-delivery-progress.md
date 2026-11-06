# Agent Note: Session Delivery Progress

Status: implemented

## Problem

Every new browser operation entered the local ledger as unknown before the HTTP
response arrived. The composer warned that delivery was unknown throughout
ordinary relay and provider submission. Normal sends therefore looked like
failures, and the warning repeatedly displaced the conversation.

## Decision

Track the current page's delivery observation separately from protocol operations.
The map contains only operation IDs and sending/waiting presentation states;
its timers start at submission, reveal the original-operation query after ten
seconds, and end progress after thirty seconds even if HTTP has not returned.
The existing response-relative query deadline, operation ledger, persistence,
admission gates and draft revision ownership remain unchanged.

An unknown receipt, request failure, disconnected transport, explicit refresh,
execution replacement or completion removes this observation and its timers.
Restored and externally observed unresolved operations have no local progress
evidence and render unknown. Queries and late receipts cannot restart progress.
Message and command acceptance remains silent; control and interaction operations
continue until confirmation. The [quiet receipts decision](../../archived/bug-fix/2026-11-03-quiet-session-receipts.md) records the rationale for success filtering. The [Session design](../../../../docs/design/task-session-protocol.md#session-view-的阅读与输入状态)
owns the mechanism and [requirements](../../../../docs/spec/task-sessions.md#基础会话交互)
own observable behavior.

## Alternatives

**Add a protocol operation state.** A browser observation does not establish a
server or provider fact. Changing the shared ledger would alter recovery and
admission contracts to solve a rendering problem.

**Treat every accepted relay receipt as in progress.** Persisted receipts survive
navigation and interruption without proving continued observation. They must
remain checkable as unknown after recovery.

**Delay only the warning.** A delay alone still labels a newly submitted request
unknown and cannot distinguish restored operations from live ones.

## Consequences

Routine delivery has a lightweight progress receipt without a warning. A slow
request offers read-only reconciliation before the uncertainty warning appears.
All shared command kinds use the same presentation evidence. The thirty-second
page timer is conservative and does not cancel requests, manufacture a protocol
result, clear drafts or permit retries. Narrow composer layout remains governed
by its independent layout rules.
