# Agent Note: Ordinary Task row not-ready badge size

Status: implemented

## Problem

The Not ready badge in an ordinary Task row is larger than the adjacent To do
status and the Ready badge on comparable rows. Expanded Goal members expose
the mismatch within the same status group, including narrow and enlarged-text
layouts.

## Decision

The shared Task row selects `--text-xs` for dependency-blocked badges, matching
its primary status and Ready badge. The selector is scoped to `.task-row`;
graph nodes and Task details retain their own sizes, and tag feedback retains
`--text-sm`. Display conditions, semantic colors and the distinction between
dependency readiness and manual pauses remain independently owned.

This extends the [ready badge decision](2026-11-20-task-row-ready-size.md)
and partially revises the original [metadata size decision](2026-11-20-task-row-metadata-size.md),
which retained both readiness indicator sizes. The [Web specification](../../../../docs/spec/daynight-web.md#项目普通-task-行)
owns the visible contract.

## Alternatives

**Change the shared blocked badge default.** Graph and detail consumers would
also change despite their independent typography and geometry.

**Keep the blocked row badge at `sm`.** This preserves the earlier emphasis but
continues to give equally related readiness and lifecycle labels different sizes.

## Consequences

Standalone rows, expanded Goal members and complete or scoped chain members
share the same readiness typography and scale with browser font preferences.
Browser regression checks cover actual Goal expansion, both languages, narrow
layouts and enlarged text, while retaining graph badge sizes and contrast checks.
