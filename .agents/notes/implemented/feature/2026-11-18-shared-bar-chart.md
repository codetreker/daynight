# Agent Note: Shared Bar Chart

Status: implemented

## Problem

Task and pull request statistics need consistent, accessible readings for integer
series, including counts beyond JavaScript's safe integer range and stable scales
when a filter changes.

## Decision

The shared BarChart accepts caller-owned labels, bigint values and an explicit
axis maximum. Integer arithmetic computes bounded drawing proportions before
conversion to CSS. One focus stop navigates the ordered points; stable keys retain
the selected reading across data updates. Keyboard focus reveals the selected
point, while pointer-initiated focus leaves the viewport in place until the new
point is selected, preserving touch targets. Callers own data, units and filtering.

## Alternatives

**Separate charts in each statistics section.** This would duplicate keyboard,
touch and precision behavior and allow the two views to diverge.

## Consequences

The component can be verified independently with synthetic series. Consumers must
provide a nonempty series, unique keys and a maximum covering every value. Short
axis labels may be truncated; partially clipped scroll-edge labels are hidden until
they fit, while complete readings remain available through the chart.
