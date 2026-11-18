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
the selected reading across data updates. Callers own data, units and filtering.

## Alternatives

**Separate charts in each statistics section.** This would duplicate keyboard,
touch and precision behavior and allow the two views to diverge.

## Consequences

The component can be verified independently with synthetic series. Consumers must
provide a nonempty series, unique keys and a maximum covering every value. Short
axis labels may be truncated; complete readings remain available through the chart.
