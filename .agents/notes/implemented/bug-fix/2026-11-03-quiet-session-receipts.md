# Agent Note: Quiet Session Receipts

Status: implemented

## Problem

The shared Session View displayed the last twelve operations above the composer, including successful historical receipts. Routine activity accumulated repeated confirmation lines and could displace an older unresolved operation from the visible list.

## Decision

Filter successful operations before limiting visible receipts. A confirmed operation, or provider acceptance of a message or native command, needs no success line or summary. Other provider-accepted operations still await confirmation. An attached error always keeps its receipt visible. When no receipts need attention, omit the receipt region entirely.

The filter belongs to presentation. The client retains operation identity and recovery state, and the [reading and draft ownership decision](2026-10-28-session-reading-and-draft-ownership.md) continues to govern draft clearing. The [Session requirements](../../../../docs/spec/task-sessions.md#基础会话交互) and [design](../../../../docs/design/task-session-protocol.md#session-view-的阅读与输入状态) own the observable contract and mechanism.

## Alternatives

**Collapse successes into one confirmation line.** This reduces repetition but still interrupts ordinary conversation with an unnecessary success receipt.

**Hide every provider-accepted receipt.** Provider acceptance completes input delivery, but settings, cancellation, refresh, and interaction responses can still need final confirmation. Hiding them would conceal pending work.

**Remove completed operations from client state.** This couples layout to operation recovery and draft ownership. Rendering can be quiet without changing those contracts.

## Consequences

Pending and unsuccessful operations remain visible with existing check controls and errors. Successful history no longer consumes the twelve visible receipt slots; more than twelve non-successful receipts remain subject to the existing display limit. The operation ledger and its storage bounds are unchanged. Future operation kinds must define their completion semantics before provider acceptance can be hidden.
