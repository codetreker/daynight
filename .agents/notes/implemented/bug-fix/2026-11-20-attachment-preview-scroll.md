# Agent Note: Accessible attachment preview in short viewports

Status: implemented

## Problem

In a narrow, short detail view, unwrapped timestamp values can extend beyond the
clipped preview. Larger browser text or surrounding controls can also consume the
space needed to read the header and attachment body.

## Decision

The shared Task and Goal preview wraps timestamps within the available preview
width. In short viewports the header can scroll independently and the detail
body can scroll when its content needs more space; both are keyboard accessible.
The attachment area reserves six rem and the preview body retains its own
reading space and scrolling. The [compact header decision](2026-11-13-compact-attachment-header.md)
retains the original alignment and desktop spacing rationale.

## Alternatives

**Keep timestamps on one line.** The value column can be narrower than the date,
so clipping hides part of the time.

**Reduce the text size or hide metadata.** Either loses the shared typography
contract or information needed to identify the attachment.

## Consequences

Short views can require scrolling through the header and detail before reading
the body. Normal views retain their existing layout, and file selection, actions,
metadata semantics and the body's independent scrolling remain unchanged.
