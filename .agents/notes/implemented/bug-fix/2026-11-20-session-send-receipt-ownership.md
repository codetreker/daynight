# Agent Note: Session Send Receipt Ownership

Status: implemented

## Problem

A failed send can surface the same operation error in both the receipt region
and the composer. On a narrow screen, duplicate text consumes conversation
space while a fixed receipt height can hide part of the only actionable result.
Other errors and independent operations still need their own feedback.

## Decision

A visible send receipt owns feedback for the same operation ID and send kind.
Composer feedback without that matching visible receipt remains available. A
single receipt fits ordinary wrapped text; long details are expandable and
multiple receipts retain a scrollable boundary. The
[Session requirements](../../../../docs/spec/task-sessions.md#基础会话交互)
own the observable behavior. The [silent operations decision](2026-11-06-silent-session-operations.md)
continues to govern which receipts need attention and when normal activity is
silent.

## Alternatives

**Deduplicate by message text.** Different operations can report identical text;
removing one would hide an independent result and its recovery action.

**Keep both messages and enlarge the receipt region.** This makes the original
message readable but leaves duplicate announcements and unnecessary displacement
of the conversation.

## Consequences

The operation identity and visible state determine whether composer feedback is
redundant. Local and independent errors remain visible, and checking an unknown
operation still targets its original ID without resending. Long information
requires an explicit expansion; multiple receipts may require scrolling.
