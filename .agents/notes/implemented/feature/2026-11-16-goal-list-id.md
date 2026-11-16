# Agent Note: Goal list ID

Status: implemented

## Problem

Goal list readers need the complete resource ID for commands and collaboration.
Opening details to retrieve it interrupts list browsing, while disclosure on the
heading interferes with selecting text.

## Decision

The Goal heading displays its full selectable ID and an independent copy button
using the Task row presentation and shared value-copy behavior. Localized Goal
feedback remains inline. The ID group and drags beginning there do not activate
the surrounding disclosure or other reading controls. The [title decision](../bug-fix/2026-11-14-goal-title-details.md)
retains the independent title action and broad disclosure target. The [Goal
specification](../../../../docs/spec/daynight-goals.md) owns the visible contract.

## Alternatives

**Keep the ID only in Goal details.** This forces readers to leave the list to
obtain a frequently used identifier.

**Reuse the entire Task row.** Goal headings have their own disclosure, progress
and scoped summary responsibilities; sharing the copy presentation and behavior
keeps those responsibilities local.

## Consequences

The ID is accessible without editing permission and remains manually selectable
when clipboard access fails. Long IDs and feedback can increase row height;
content wraps rather than clipping. The row must distinguish selection from
disclosure while preserving the other independent controls.
