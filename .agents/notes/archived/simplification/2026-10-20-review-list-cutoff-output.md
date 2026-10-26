# Agent Note: Review Listing Cutoff Output

Status: implemented

## Problem

A review status listing repeats each repository's permanent tracking boundary
alongside the local observation and PR status. The extra line adds repeated
setup information when operators are checking review progress across repositories.

## Decision

`daynight review list` and `daynight review ls` omit the per-repository cutoff
notice. The listing retains its local-snapshot notice, observation times, saved
errors, initialization messages and PR details. Permanent exclusion and tracked-PR
selection remain unchanged.

This partially supersedes the [original listing decision](../feature/2026-10-18-review-status-listing.md),
which displayed the boundary to explain why older PRs could not be enumerated.
The [requirements](../../../../docs/spec/daynight-review.md) own the current visible
behavior.

## Alternatives

**Retain the cutoff notice.** The original output made the tracking limit visible
in every initialized repository group. Repeating that setup detail adds noise to
the routine progress view; the documented tracking rules and tracked-PR wording
continue to define the listing's scope.

## Consequences

Each initialized repository group uses one fewer line. Operators inspect the same
tracked PRs and statuses, while the permanent boundary remains documented rather
than printed during each status query. No persisted data or review scheduling
changes.
