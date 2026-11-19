# Agent Note: Root-Independent Web Layout Geometry

Status: implemented

## Problem

Several Web layouts use `rem` for fixed control and container geometry. Their
sizes therefore depend on the 14px root font size, so changing the typography
scale also changes widths, spacing and terminal viewport constraints.

## Decision

Search, draft attachments, Goal details, Worker prompts, GitHub settings, Task
organization and the terminal host express fixed layout geometry in CSS pixels
at the equivalent 14px-root values. Font sizes and text-related spacing retain
relative units. These layouts do not set the root font size or typography roles.

## Alternatives

**Keep all layout lengths in `rem`.** A root typography change would also resize
controls and containers, including the terminal timeline and prompt columns.

## Consequences

The affected fixed geometry is independent of root typography while browser zoom
still scales the whole interface. Content can wrap or scroll within its existing
containers. Other Web layouts retain their own root-relative lengths and require
separate review before the root size changes.
