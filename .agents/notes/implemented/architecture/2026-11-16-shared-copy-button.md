# Agent Note: Shared Copy Button Presentation

Status: implemented

## Problem

Copy actions appear across task lists and details, settings, setup, secrets and
Worker paths. Independent button skins and glyphs can diverge, and a generic
button's persistent border, background and shadow make a compact copy action
visually heavy. The actions also have distinct admission and feedback lifecycles
that must remain intact.

## Decision

A shared copy button owns the native button, decorative overlapping-squares icon
and internal presentation for icon-only and text actions. It uses a transparent
resting surface, a light enabled hover and a visible keyboard focus outline;
external layout and localized labels belong to consumers. The [Web design](../../../../docs/design/daynight-web.md#复制控件的职责)
owns the visual contract. A separate shared value-copy adapter serves Task and
Goal consumers. Team, Setup, Webhook, secret dialogs and Worker paths retain
their own clipboard operations, guards, feedback and identity boundaries. The
[Team ID decision](../feature/2026-11-05-web-team-id-copy.md) retains the rationale
for its independent admission and notification lifecycle.

## Alternatives

**Keep each feature's glyph and button skin.** The Team ID decision originally
kept a small duplicate to avoid coupling its feedback to Task detail. Repeating
presentation leaves visual states and geometry under multiple owners, even though
sharing a glyph need not merge clipboard behavior.

**Unify the clipboard workflow as well as the presentation.** The existing
consumers have different admission, identity, notification and selection rules.
Combining them would couple those lifecycles and complicate their failure paths.

## Consequences

All copy actions have one presentation owner and can retain their existing text,
permissions and feedback. The presentation component does not itself enforce
consumer admission or asynchronous isolation; those remain responsibilities of
each operation. Task and Goal share their value-copy lifecycle without depending
on the Task row feature, and Team remains independently focusable when
`aria-disabled`.
