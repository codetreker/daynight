# Agent Note: PR Status Icon Alignment

Status: implemented

## Problem

PR card status icons sat near the top of the card, increasingly distant from
its vertical center when titles or metadata wrapped across multiple lines.

## Decision

The status icon aligns itself to the center of the card's flex cross axis,
without a fixed top offset. Other card children retain their alignment. The
[PR reading design](../../../../docs/design/github-pr-reading.md#web-工作区与列表)
owns the current layout; the [card decision](../feature/2026-11-17-pr-list-cards.md)
retains the original grouping rationale.

## Alternatives

**Keep the fixed top offset.** A constant offset cannot center an icon in cards
whose height changes with content and viewport width.

## Consequences

The icon follows the card's height without changing card dimensions or the
alignment of its text, date, and detail affordance. Browser geometry checks
cover the state variants and responsive card sizes.
