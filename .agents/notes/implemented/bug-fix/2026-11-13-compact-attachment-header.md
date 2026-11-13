# Agent Note: Compact Attachment Header

Status: implemented

## Problem

The shared attachment preview header reserved a fixed width for short file information, leaving an excessive gap before timestamps. Independently sized label columns also put timestamp values at different horizontal positions. The header must remain readable in narrow and short viewports.

## Decision

File information sizes to its content, can shrink and is capped at 240px on desktop. A single definition list provides shared label and value columns for both timestamps; responsive rules wrap groups or restore the shared columns beside actions in the smallest viewport. The [timestamp decision](../feature/2026-11-12-attachment-preview-timestamps.md) retains the metadata and formatting rationale.

## Alternatives

**Independent rows with fixed label widths.** A fixed width could align one locale but would need separate sizing for other labels and could waste scarce space.

**Reserve the maximum file width.** This limits long paths but creates the same visible empty space for short names.

## Consequences

Short file names no longer reserve unused width and both values align across locales. Long information remains truncated visually with full text available, while narrow layouts spend additional vertical space to keep timestamps and actions usable. Browser geometry checks are needed because semantic structure alone does not establish alignment or clipping.
