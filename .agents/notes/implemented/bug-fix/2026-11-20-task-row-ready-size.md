# Agent Note: Ordinary Task row ready badge size

Status: implemented

## Problem

In a ready ordinary Task row, the ready badge is larger than the adjacent
lifecycle status. This makes two equally related status labels compete for
attention, including in narrow and enlarged-text layouts.

## Decision

The shared Task row uses `--text-xs` for the ready badge, matching the primary
status. This decision originally retained dependency-blocked and tag feedback
text at `--text-sm`; the later [not-ready badge decision](2026-11-23-task-row-not-ready-size.md)
also assigns dependency-blocked row indicators to `--text-xs`. Tag feedback, graph,
detail and summary presentations remain independently owned. This partially
revises the [row metadata decision](2026-11-20-task-row-metadata-size.md), which
originally retained both indicator sizes. The [Web specification](../../../../docs/spec/daynight-web.md#项目普通-task-行)
owns the visible contract.

## Alternatives

**Keep the ready badge at `sm`.** This preserves the earlier hierarchy but leaves
it larger than the adjacent primary status.

## Consequences

All consumers of the shared row use the same ready badge size and respect the
browser root font size. The badge retains its conditions, text and other
styling. The original scope left blocked indicators at their existing emphasis;
the later not-ready badge decision aligns their row typography with readiness.
