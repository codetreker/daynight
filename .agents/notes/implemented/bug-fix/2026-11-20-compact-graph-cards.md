# Agent Note: Compact Graph Cards

Status: implemented

## Problem

Short task titles without a usage reading leave substantial empty space between
the title and status in both dependency graphs. Oversized cards consume canvas
space and reduce the amount of graph visible at a readable scale.

## Decision

Both graphs adopted shared dimensions in `layout.ts`, a two-line title, metadata,
optional numeric usage, status, execution information and independent Details.
Direction and external navigation controls retained their separate footer. Root
font scaling applied to geometry and coordinates independently of graph zoom.
The later [compact reading decision](2026-11-20-compact-graph-readings.md) replaces
the card content and dimensions while retaining shared geometry and scaling.

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
or usage reads. The original smaller content budget depended on compact graph-only badges,
truncatable ownership and separate footer and Details positions. Browser geometry
checks remain necessary for long text, both languages and larger root fonts.
