# Agent Note: Session Form Multi-Select

Status: implemented

## Problem

Native multi-select lists render options on one line in Chromium, so long
Session form options are clipped on narrow screens. Their default list height
also leaves unused space when a field has few options.

## Decision

Session form multi-select fields use a named checkbox group with wrapping rows.
Each row is a label and a touch target, and selection is returned as option IDs
in the original option order. Required validation and response permissions remain
with the interaction card. Single-value choices retain the shared native select
and its popup behavior, as described in the [native select decision](../architecture/2026-11-14-shared-native-select.md).

## Alternatives

**Keep the native list.** It preserves native list interaction but cannot show
long option text without clipping in the affected browser, even at some wider
viewport sizes.

## Consequences

Every option remains individually readable and selectable without horizontal
scrolling. Long fields grow with their content and use the existing timeline
scroll. Checkbox navigation takes one Tab stop per option; the response shape
and option identifiers do not change.
