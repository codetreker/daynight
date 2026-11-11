# Agent Note: Worker Card Monitoring Summary

Status: implemented

## Problem

Worker list cards compete for space with machine identity, status and task count.
Admission reasons and monitoring timestamps add diagnostic detail to every card,
although operators can open the Worker for its complete observation.

## Decision

List cards show the scheduler phase and capacity, retaining the capacity stale
indicator and existing missing or expired states. They omit admission reasons,
reason entry times and monitoring receipt time and age. The detail page remains
the diagnostic surface. The batch summary and its permission projection remain
unchanged. The [Web monitoring decision](../architecture/2026-11-09-web-worker-monitoring.md)
retains the independent observation and freshness model; the
[summary permission decision](../architecture/2026-11-09-monitoring-summary-permissions.md)
retains the protocol and its original rationale.

## Alternatives

**Keep diagnostic lines on each card.** This makes reasons immediately visible,
but crowds the overview with information available in the detail page.

**Hide the lines with CSS.** This retains unnecessary rendered content and can
leave diagnostic information accessible in the card despite the presentation
change. Removing the nodes makes the information boundary explicit.

## Consequences

Cards naturally contract without a replacement placeholder. Operators must open
detail for diagnostics; monitoring expiry and independent read failures remain
visible in the overview. No additional per-card detail request is needed.
