# Agent Note: Shared UI design principles

Status: implemented

## Problem

Repeated status messages and operating instructions add reading work when
controls already express the same business rules. Removing all status text,
however, can hide business facts or real failures. Interface changes need a
shared rule that distinguishes those cases and remains discoverable during
design and review.

## Decision

The [UI design document](../../../../docs/ui-design.md) owns shared principles,
examples, and their information boundaries. The root
[agent instructions](../../../../AGENTS.md#writing-and-review) require following
it when designing, adding, modifying, or reviewing UI. The
[README](../../../../README.md#documentation-conventions) registers its ownership.
Product specifications and design documents continue to own concrete behavior.

The principle favors control states and interaction flows for expressing
business rules and excludes visible messages that repeat those meanings.
Business information, field labels, and real errors remain clear and visible.
Disabled reasons that context cannot explain may appear on demand, with
keyboard-focus access to explanations available on hover.

## Alternatives

**Exclude all visible status text.** This would also remove business facts such
as task status and actionable failure information. The distinction between
redundant explanation and necessary information preserves those uses.

**Repeat the principles in the agent instructions.** This makes the rules
immediately visible there but creates a second owner that can drift. A required
link keeps the instruction discoverable while the examples and boundaries stay
together in their owning document.

## Consequences

UI work shares one reference for expressing rules through controls while keeping
essential information readable. On-demand explanations need keyboard access as
well as hover access. This establishes documentation policy; existing product
behavior remains defined by its specifications and design documents.
