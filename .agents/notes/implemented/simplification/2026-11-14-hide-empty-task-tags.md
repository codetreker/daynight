# Agent Note: Hide Empty Task Tag Displays

Status: implemented

## Problem

An empty tag set is common in Task and Goal lists. Its placeholder consumes a
separate line even though it adds no classification, making rows taller and
reducing the amount of work visible at once.

## Decision

Ordinary tag displays render no element for an empty set. Goal and Task row
accessible references include the tag region only when it exists. Reconciliation
still explicitly identifies an observed empty set, distinguishing it from an
unknown write outcome or a failed read. The [earlier display decision](../feature/2026-11-13-web-task-tag-display.md)
retains the independent item data and wrapping behavior.

## Alternatives

**Keep a localized placeholder.** This makes an empty classification explicit,
but reserves a line in every empty row. Explicit emptiness remains useful in
reconciliation, where the observed set has a specific decision context.

## Consequences

Empty rows shrink to their existing minimum or natural content height; nonempty
tags continue to wrap without a fixed-height crop. Filters retain their explicit
untagged choice and editing remains available in details.
