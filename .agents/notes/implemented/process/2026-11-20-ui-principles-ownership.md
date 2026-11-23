# Agent Note: UI Principles and Detail Ownership

Status: implemented

## Problem

The UI principles had acquired feature rules, exact values, and test procedures.
Readers could not tell which rules applied to every interface, and individual
feature documents depended on a general guide for their own behavior.

## Decision

The [UI design principles](../../../../docs/ui-design.md) own requirements that
apply across interfaces. The [typography standard](../../../../docs/spec/web-typography.md)
owns the allowed sizes, and the [visual standards](../../../../docs/design/web-visual-tokens.md)
own exact brand and palette values. Components and features own their individual
behavior; the Web validation guide owns checks and tooling.

## Alternatives

**Keep every UI rule in one document.** Finding an exact value would remain
easy, but each new feature exception would make the principles less useful as
a common review standard and blur its contract with the feature owner.

## Consequences

Changes to values or feature behavior can be documented at their owners without
changing the principles. The principles link to those owners so readers can find
the details without maintaining duplicate definitions.
