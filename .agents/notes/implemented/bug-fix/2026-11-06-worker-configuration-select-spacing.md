# Agent Note: Worker Configuration Select Spacing

Status: implemented

## Problem

Browser-drawn select arrows can sit against the right border of Worker
configuration fields. Their position varies independently of text padding, and
long localized choices need room to remain separate from the arrow.

## Decision

The original Worker configuration fix retained native controls inside a scoped
wrapper drawing a noninteractive chevron at a fixed inset. The select reserved
space for the chevron and truncated choices that did not fit; the wrapper also
reflected the disabled state in its arrow color. This gave the four configuration
select types common geometry without changing other field consumers.

The [shared native select decision](../architecture/2026-11-14-shared-native-select.md)
owns the reusable replacement. Worker configuration now uses its `form`/`fill`
variant, including the later control-mode field; the local wrapper and arrow
rules have no remaining ownership. The configuration editor retains its values,
inheritance, draft and save behavior. In particular, the real control-mode select
ref and layout effect preserve no selection with exactly the `herdr` and `web`
options. The [configuration editor decision](../../archived/architecture/2026-11-04-web-worker-configuration-editor.md)
records the original configuration and draft rationale.

## Alternatives

**Keep the browser arrow and adjust padding.** Browsers control the arrow's
position separately, so padding cannot guarantee an inset from the border.

**Replace the native control with a custom menu.** A custom menu would need to
reimplement selection, keyboard, focus and disabled behavior for a visual fix.

## Consequences

The original fixed-inset decision remains the reason for drawing a decorative
arrow while preserving the native control. Its geometry and disabled and
forced-color treatments are now maintained by the shared component. Worker
browser regressions check that consumer integration and form layout continue to
use that owner. Long selected labels may be truncated when space is limited;
their full options remain available in the native menu.
