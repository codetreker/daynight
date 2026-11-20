# Agent Note: Compact Graph Cards

Status: implemented

## Problem

Short task titles without a usage reading leave substantial empty space between
the title and status in both dependency graphs. Oversized cards consume canvas
space and reduce the amount of graph visible at a readable scale.

## Decision

Both graphs use the dimensions defined by `layout.ts` and the compact shared
card content described in the [inspection design](../../../../docs/design/daynight-task-inspection.md#责任与数据流).
The body retains the two-line title, metadata, optional numeric usage, status,
execution information and independent Details action. Direction and external
navigation controls retain their separate footer. Root font scaling applies to
the geometry and coordinates independently of graph zoom.

This changes the base card dimensions chosen by the [semantic typography
decision](../architecture/2026-11-20-web-semantic-typography.md), while preserving
its font roles and proportional graph scaling. Goal inspection and external
navigation retain their respective interaction and projection decisions.

## Alternatives

**Hide only the empty usage row.** This avoids a placeholder but leaves the
outer card and its unnecessary vertical space unchanged.

**Shrink the CSS box or initial zoom alone.** Layout, edge routing and viewport
calculations would continue to use different dimensions, or the smaller text
would compromise readability. Shared geometry keeps those calculations aligned.

## Consequences

More cards fit within the same graph area without changing the visible task set
or usage reads. The smaller content budget depends on compact graph-only badges,
truncatable ownership and separate footer and Details positions. Browser geometry
checks remain necessary for long text, both languages and larger root fonts.
