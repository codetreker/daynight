# Agent Note: Bar Chart Label Height

Status: implemented

## Problem

The shared chart's fixed label row was shorter than the inherited label line
height plus its top spacing. The resulting fractional overflow produced a
vertical scroll range in both project statistics charts.

## Decision

The label row height includes one computed line height and the label's top
spacing. The chart retains horizontal scrolling and its existing reading and
selection behavior. The [shared chart decision](../feature/2026-11-18-shared-bar-chart.md)
describes the component's interaction responsibilities.

## Alternatives

**Hide vertical overflow.** This conceals the scrollbar without ensuring that
the label fits and can leave a programmatic scroll range or clip content.

**Keep a fixed row height.** A larger fixed value would still depend on the
inherited line height and fail when label text is enlarged.

## Consequences

The row grows with its own line height, preserving the label without adding
vertical scrolling. Browser tests load production typography and exercise the
shared component and both statistics consumers.
