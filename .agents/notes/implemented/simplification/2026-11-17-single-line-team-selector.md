# Agent Note: Single-Line Team Selector

Status: implemented

## Problem

The expanded sidebar selector gives the selected scope's type a separate line
above its name. That line and its empty placeholder for unknown types consume
space in the compact navigation control.

## Decision

The expanded selector displays the avatar, one name line and the arrow, without
a type line or its placeholder. The full name and known type remain available in
the button's accessible name and title. The same presentation applies in the
mobile drawer; the collapsed rail retains its icon entry. The existing menu and
selection behavior remain unchanged. The subsequent [compact selector decision](../bug-fix/2026-11-17-compact-team-selector.md) changes its dimensions and arrow geometry while retaining this single-line presentation.

This partially replaces the visible type label in the [sidebar scopes
decision](../architecture/2026-11-12-sidebar-navigation-scopes.md); its grouping
and scope rules continue to apply.

## Alternatives

**Keep the visible type line.** The original scope design used it to distinguish
Team and Personal selections, but it occupies a second line even when the type
is unknown. The accessible name and title retain the known distinction without
that space.

## Consequences

Names align beside the avatar without a reserved type row, including loading,
failure and unknown-type states. The type is no longer always visible in the
expanded control; readers can obtain a known type from its accessible name or
title. Long names still truncate visually while the complete name remains
available through those descriptions.
