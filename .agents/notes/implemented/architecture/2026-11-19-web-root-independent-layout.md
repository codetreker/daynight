# Agent Note: Root-Independent Web Layout Geometry

Status: implemented

## Problem

Several Web layouts use `rem` for fixed control and container geometry. Their
sizes therefore depend on the 14px root font size, so changing the typography
scale also changes widths, spacing and terminal viewport constraints.

## Decision

Search, draft attachments, Goal details, Worker prompts, GitHub settings, Task
organization and the terminal host express fixed layout geometry in CSS pixels
at the equivalent 14px-root values. Text-related spacing retains relative units. The [semantic typography decision](2026-11-20-web-semantic-typography.md)
changes the root and preserves the unconverted feature sizes at their former
values until their semantic migration.

## Alternatives

**Keep all layout lengths in `rem`.** A root typography change would also resize
controls and containers, including the terminal timeline and prompt columns.

## Consequences

The affected fixed geometry is independent of root typography while browser zoom
still scales the whole interface. Content can wrap or scroll within its existing
containers. Other fixed geometry that depended on the old root is also made independent
of it as part of the semantic typography decision.
