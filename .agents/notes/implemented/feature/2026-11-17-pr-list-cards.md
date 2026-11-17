# Agent Note: PR List Cards

Status: implemented

## Problem

The Project PR list used a continuous bordered surface while the Task list used
separate cards. The differing spacing and text hierarchy made adjacent Project
lists harder to scan consistently, especially in constrained content areas.

## Decision

The PR workspace owns separate neutral cards with the Task list's spacing and
typographic hierarchy. A container query adjusts density to the actual list
width. PR status, icons, labels, data and reading interactions remain owned by
the PR model. The [PR reading design](../../../../docs/design/github-pr-reading.md#web-工作区与列表)
describes the presentation and workspace behavior.

## Alternatives

**Reuse the Task row component.** Its model carries Task execution, Session,
dependency and other business data that PRs do not have; fabricating it would
couple unrelated models for a visual similarity.

**Keep the continuous list.** It preserves the existing layout but leaves the
visual density and grouping inconsistent with the adjacent Task list.

## Consequences

PR and Task entries share a reading rhythm without conflating their state
semantics. PR styles retain their own maintenance responsibility, including
responsive geometry and accessible focus; shared Task row changes do not
automatically propagate to the PR list.
