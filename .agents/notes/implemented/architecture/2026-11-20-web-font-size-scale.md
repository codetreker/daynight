# Agent Note: Web Font Size Scale

Status: implemented

## Problem

Web typography has one size owner, but consumers select tokens named for their
purpose. Text serving different purposes can need the same size, and text
serving the same purpose can need different sizes. Changing a single surface
should not require misclassifying the text or changing every surface in its role.

## Decision

The [Web typography specification](../../../../docs/spec/web-typography.md)
defines six shared sizes named by magnitude. Consumers select or inherit a size;
the standard owns the rules for browser scaling, touch accessibility, and
terminal zoom. This replaces purpose-based selection in the [role-based
decision](2026-11-20-web-semantic-typography.md) while retaining centralized
ownership and browser-relative sizes. The [migration policy](2026-11-20-web-typography-migration-policy.md)
records the bounded compatibility window used to migrate consumers.

## Alternatives

**Keep purpose tokens as aliases.** This preserves old identifiers but keeps
two ways to select the same size and continues to imply that certain sizes belong
to particular purposes.

**Add a smaller reading token.** This accommodates one consumer but leaves
controls, titles, and other purposes subject to the same coupling.

## Consequences

First-party Web text and renderer settings select or inherit an allowed size.
The ownership check rejects independent definitions, retired names and fallbacks.
Changing one consumer's selection does not affect other consumers, while changing
a scale value affects its users. Browser validation remains necessary for text
scaling, touch readability, terminal zoom, narrow-screen reflow and renderer
integrations that static analysis cannot prove. Touch and terminal adjustments
remain shared rendering behavior rather than additional authored sizes.
