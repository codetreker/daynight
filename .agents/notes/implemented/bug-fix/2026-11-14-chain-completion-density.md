# Agent Note: Compact chain completion metadata

Status: implemented

## Problem

Moving chain completion time below the title introduced excess vertical space in
otherwise unwrapped summaries. The button inherited a larger line box and added
vertical padding, making equivalent summaries taller when completion time appears.

## Decision

The chain summary gives its completion button a 0.75rem font, 17px line height,
zero vertical padding and a centered flex box. Full and scoped chains share this
rule. The [chain time layout decision](../architecture/2026-11-13-chain-completion-time-layout.md)
retains the independent controls and metadata placement; the
[completion time design](../../../../docs/design/daynight-completion-time.md)
owns their presentation and interaction.

## Alternatives

**Fix the summary height.** Long titles and metadata can wrap, so a fixed height
would risk clipping or overlapping content.

**Change the shared completion label.** Other Task and Goal consumers use that
label and do not need the chain button's box model; a shared change would widen
the effects of this correction.

## Consequences

Unwrapped metadata fits the 17px avatar line whether or not a time button is
present. Longer content can still grow naturally. The compact button retains
its independent hint and disclosure behavior; shared labels remain unchanged.
