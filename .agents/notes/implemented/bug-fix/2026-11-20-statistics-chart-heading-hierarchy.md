# Agent Note: Statistics Chart Heading Hierarchy

Status: implemented

## Problem

The daily charts' headings had the same visual size as their containing card
headings, making the hierarchy between each card and its chart unclear.

## Decision

Project statistics chart headings use the shared interface text role. Card
headings retain the section heading role, and chart headings retain their `h3`
semantics and existing layout.

## Alternatives

**Keep the section heading role:** This leaves chart labels visually equal to
their parent card headings.

## Consequences

At the default root size, chart headings are 14px and card headings are 18px.
The shared roles continue to follow the browser's root font preference; chart
controls, readings, and responsive layout remain independent of this choice.
