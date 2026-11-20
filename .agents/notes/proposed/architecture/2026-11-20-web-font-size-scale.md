# Agent Note: Web Font Size Scale

Status: proposed

## Problem

Web typography has one size owner, but consumers select tokens named for their
purpose. Text serving different purposes can need the same size, and text
serving the same purpose can need different sizes. Changing a single surface
should not require misclassifying the text or changing every surface in its role.

## Proposal

The [Web typography specification](../../../../docs/spec/web-typography.md)
defines six shared sizes named by magnitude. Consumers select or inherit a size;
the standard owns the rules for browser scaling, touch accessibility, and
terminal zoom. This replaces purpose-based selection in the [role-based
decision](../../implemented/architecture/2026-11-20-web-semantic-typography.md)
while retaining centralized ownership and browser-relative sizes.

## Alternatives

**Keep purpose tokens as aliases.** This preserves old identifiers but keeps
two ways to select the same size and continues to imply that certain sizes belong
to particular purposes.

**Add a smaller reading token.** This accommodates one consumer but leaves
controls, titles, and other purposes subject to the same coupling.

## Acceptance Criteria

First-party Web text and renderer settings select or inherit an allowed size.
The ownership check rejects independent definitions and fallbacks. Selecting a
different size in one consumer does not change others, while changing a scale
value affects every consumer of that value. Browser validation preserves text
scaling, touch readability, terminal zoom, and narrow-screen reflow.

## Risks

An unrestricted size parameter would recreate a second scale. Touch and terminal
adjustments must remain shared rendering behavior, not additional authored sizes.
Renderer integrations require validation where static CSS analysis cannot prove
the resulting size.
