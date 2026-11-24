# Agent Note: Deletion confirmation read isolation

Status: implemented

## Problem

The deletion confirmation tests count Task detail reads to detect unwanted
retries. The independently scheduled relationship reader shares that API spy,
so its read can change the count depending on when deletion becomes pending.

## Decision

The deletion confirmation test replaces the relationship component with a
render-callback stub that leaves its parent and children slots empty. The detail
layout and exact read and delete-write assertions remain in the test. Dedicated
relationship tests retain responsibility for relationship reads and behavior.

## Alternatives

**Count both reads.** The relationship effect can be cancelled before it starts,
so an exact combined count depends on scheduling rather than deletion behavior.

## Consequences

The read count measures the detail operation under test without exercising the
relationship reader in this file. Relationship behavior must remain covered by
its independent tests.
