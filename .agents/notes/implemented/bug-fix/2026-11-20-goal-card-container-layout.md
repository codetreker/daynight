# Agent Note: Goal card container layout

Status: implemented

## Problem

A Goal card can be narrow even in a wide viewport, such as beside the project
sidebar. Its fixed progress, status and action columns then compete with the
title and complete ID, leaving too little room for the summary.

## Decision

The named Goal card inline-size container selects the compact row grid at a
content width of 740px or less. The summary occupies the first row, with progress
below the main information; status and the independent actions occupy the next
row. Wider cards retain the horizontal layout. The 600px inset and 50px prefix
remain governed by the [prefix spacing decision](2026-11-16-goal-list-prefix-spacing.md).
The [Web design](../../../../docs/design/daynight-web.md) describes the geometry.

## Alternatives

**Keep the viewport breakpoint and wrap only the summary.** A narrow card in a
wide viewport still reserves horizontal space for status and actions, so the
summary remains cramped.

**Shrink or hide text and controls.** This would sacrifice readable information
and accessible actions instead of using the available vertical space.

## Consequences

The layout responds to the space actually available to the card, independent of
the page viewport. Compact cards can grow vertically for long or localized
content, while their status and action controls remain separate and reachable.
