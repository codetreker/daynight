# Agent Note: Ordinary Task row ready badge size

Status: implemented

## Problem

In a ready ordinary Task row, the ready badge is larger than the adjacent
lifecycle status. This makes two equally related status labels compete for
attention, including in narrow and enlarged-text layouts.

## Decision

The shared Task row uses `--text-xs` for the ready badge, matching the primary
status. Dependency-blocked and tag feedback text retain `--text-sm`; graph,
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
styling; blocked indicators keep their existing emphasis.
