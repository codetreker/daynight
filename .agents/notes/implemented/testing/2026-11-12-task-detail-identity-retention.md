# Agent Note: Task Detail Identity Retention Collaboration

Status: implemented

## Problem

Task mutations, discussion posts, attachments, cache identity admission and the
ordinary request lifetime have separate owners. Their individual tests do not
establish that a single retained detail remains usable when a trusted response
reveals a different principal while work is in flight.

## Decision

The Task detail module regression composes the production owners under one real
cache scope and controls HTTP responses and operation barriers. A different
principal reaches the scope through the actual Task response check. The account
owner observes the still-live scope and pauses admission before cancelling the
shared ordinary network lifetime. Dispatch and trusted receipt barriers distinguish
local cancellation, unknown and confirmed outcomes from subsequent publication.
The [Task inspection design](../../../../docs/design/daynight-task-inspection.md#验证与交付)
owns the observable collaboration contract.

## Alternatives

**Exercise each owner only in isolation.** Those tests do not establish the
ordering between a real principal mismatch, the root policy, the retained scope,
and the shared network lifetime.

**Call the pause policy directly.** This does not exercise the Task response
principal check or prove that scope destruction has not already happened before
the account owner is notified.

## Consequences

The controlled module test can observe retained presentation, local settlement,
network cancellation and cleanup in one scope without simulating the production
owners' state machines. It does not establish real cross-tab notification, final
root and header integration or browser-native dispatch; those require browser
integration evidence. Existing owner tests remain responsible for their broader
individual behavior.
