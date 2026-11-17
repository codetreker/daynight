# Agent Note: Compact Team Selector

Status: implemented

## Problem

The single-line Team selector retains the earlier two-line control's 48px
height. Its text chevron aligns by its line box, while the visible glyph sits
below the center on some fonts. Both leave the dark sidebar entry visually
unbalanced.

## Decision

The selector uses a centered 12px decorative SVG chevron and a 24px avatar.
Its trigger is 36px high on wide fine-pointer displays and at least 44×44px
on narrow or coarse-pointer layouts, including the collapsed rail. The
[single-line decision](../simplification/2026-11-17-single-line-team-selector.md)
and [popover decision](../feature/2026-11-05-team-switcher-popover.md) retain
their name, menu and focus contracts.

## Alternatives

**Offset the text glyph.** A positional adjustment depends on the active font's
glyph metrics and does not provide stable drawing geometry.

**Use the shared SelectTrigger.** Its shared light control skin is owned by the
selection component; the dark Team entry has its own presentation and cannot
override that skin without changing the common contract.

## Consequences

The arrow has font-independent geometry and the compact desktop control no
longer reserves excess vertical space. Touch targets retain their larger size;
responsive cascade and actual popover anchoring require browser verification.
