# Agent Note: Session History Layout Containment

Status: implemented

## Problem

After switching between retained Bot Sessions, Chromium can leave newly prepended
history entries without layout boxes when the timeline shell uses size
containment. The scroll height and reading position then do not reflect the new
page, so automatic pagination can continue through successive pages while the
reader remains at the top.

## Decision

The timeline measures its shell with a `ResizeObserver` to select the compact
navigation layout at 120px or less. It does not apply size containment to the
shell. This preserves the threshold and overlay behavior described by the
[tall pending interaction decision](2026-11-20-tall-pending-interaction-navigation.md)
while allowing newly inserted history to participate in layout. A window resize
listener also updates the measurement when `ResizeObserver` is unavailable.

## Alternatives

**Limit pagination after one request.** Filtered pages can contain no visible
rows, and short timelines may need additional pages to fill the viewport. A
request limit would hide the layout defect and interrupt those cases.

**Keep size containment.** The affected Chromium sequence can retain DOM nodes
without layout boxes after a hidden Session is shown again, so the existing
reading-anchor and geometry checks cannot observe the added page correctly.

## Consequences

The shared Timeline uses one observer per mounted shell and removes it on
unmount. Navigation still follows the shell height, including changes caused by
composer layout, without changing history cursors or reading intent. Browser
coverage checks immediate and held page responses, the original anchor, and the
short pending-form navigation in Task and Test views.
