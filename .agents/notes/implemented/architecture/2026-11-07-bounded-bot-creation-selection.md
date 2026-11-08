# Agent Note: Bounded Bot creation selection

Status: implemented

## Problem

A Bot creation needs one configuration, but reading the complete defaults directory
makes it decode every historical Worker and preference. Active admission limits do
not bound inactive history. Defaults consumers still need the complete directory
and reasons for unavailable Workers.

## Decision

Creation uses owner-scoped target reads and small active candidate projections,
then reads the selected Worker's native configuration and preferences. The core
uses the same resolution rules as the full directory and repeats selection inside
the creation transaction. A scan reads at most 101 candidates and rejects an
active set over 100 instead of selecting from a truncated inventory. Explicit
selection and a valid preferred choice do not require a scan. The
[assistant design](../../../../docs/design/assistant.md#默认解析与偏好事务)
owns the data flow and freshness rules.

This narrows creation reads while preserving the original
[defaults and preference decision](../../archived/architecture/2026-11-04-bot-default-resolution.md).

## Alternatives

**Use the full defaults directory for creation.** Inactive Worker history can
grow without bound, even though a creation needs only one configuration.

**Truncate the directory or choose among the first 100 active Workers.** The
former changes the public directory; the latter hides an over-capacity set and
can misreport availability. A bounded lookahead detects the overflow instead.

## Consequences

Explicit creation does not decode other Workers' full snapshots. Automatic
selection incurs a bounded projection and a selected-target read; changing data
is resolved again before the configuration is frozen. The full defaults directory
remains unpaged and its cost can still grow with historical Worker inventory.
