# Agent Note: Session Archive Capacity

Status: implemented

## Problem

A single instance slot and owner slot make unrelated archive operations compete
even when the server has capacity. Increasing admission without bounding both
the instance and shared owner can multiply memory use or let one owner consume
all capacity across servers.

## Decision

The shared Session Engine receives independent positive instance and owner
limits at startup, defaulting to 20 and 5. Preflight capacity follows the
instance limit. Admission takes an instance slot before the original-owner
permit and returns it on owner refusal. Operation and retained response ownership
continue to follow the [residency decision](2026-11-07-session-archive-residency.md)
and [owner permit decision](2026-11-21-session-archive-owner-permits.md).

## Alternatives

**One shared limit.** It cannot independently constrain per-process memory and
the combined activity of an owner across instances.

## Consequences

Operators can tune both bounds independently, but changes take effect on restart.
Nodes sharing a coordination domain must drain higher-limit nodes before lowering
the owner limit; during an increase each node judges the shared count against its
own limit, so the highest active limit bounds the rollout.
