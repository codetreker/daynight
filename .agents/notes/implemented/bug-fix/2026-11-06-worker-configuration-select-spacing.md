# Agent Note: Worker Configuration Select Spacing

Status: implemented

## Problem

Browser-drawn select arrows can sit against the right border of Worker
configuration fields. Their position varies independently of text padding, and
long localized choices need room to remain separate from the arrow.

## Decision

Worker configuration selects retain native controls inside a scoped wrapper that
draws a noninteractive chevron at a fixed inset. The select reserves space for
the chevron and truncates choices that do not fit. The wrapper also reflects the
disabled state in its arrow color. The [configuration editor decision](../../archived/architecture/2026-11-04-web-worker-configuration-editor.md)
records the rationale for the existing configuration and draft behavior.

## Alternatives

**Keep the browser arrow and adjust padding.** Browsers control the arrow's
position separately, so padding cannot guarantee an inset from the border.

**Replace the native control with a custom menu.** A custom menu would need to
reimplement selection, keyboard, focus and disabled behavior for a visual fix.

## Consequences

All four Worker configuration select types share the same arrow geometry without
changing other field consumers. Long selected labels may be truncated when space
is limited; their full options remain available in the native menu. The arrow's
contrast and placement need verification in disabled and forced-color modes.
