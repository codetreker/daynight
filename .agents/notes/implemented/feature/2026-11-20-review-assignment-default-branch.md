# Agent Note: Default-branch eligibility for review assignments

Status: implemented

## Problem

A repository may have open pull requests for release or other branches that
should not receive a new reviewer. The server needs a consistent repository
observation and must avoid assigning from stale PR or repository facts while
retaining reviewers already assigned under the earlier rule.

## Decision

First assignment requires an open PR whose saved base ref exactly matches the
current repository's validated, synchronized default branch. Successful
repository observations publish that branch, including unknown when absent or
invalid; failed observations retain the last successful value. Switching
repositories clears it. The bounded scan filters by the current connection and
the write transaction rechecks the locked connection and PR before insertion.
Existing assignments and their single-PR read remain unchanged. The
[assignment design](../../../../docs/design/pr-review-assignment.md) owns the
transaction and synchronization details. This narrows the initial eligibility
in the [persistent assignment decision](../architecture/2026-11-19-pr-review-assignment.md).

## Alternatives

**Query GitHub for every candidate.** This adds remote requests and failure
dependencies to reconciliation while the existing repository synchronization
can provide the necessary fact once per observation.

**Remove existing ineligible assignments.** That would change durable reviewer
ownership when PRs are retargeted or the default branch changes; retaining them
allows the existing owner to remain authoritative when eligibility returns.

## Consequences

An unknown default branch delays first assignment until a successful valid
observation. Branch and PR updates converge through normal synchronization and
reconciliation; a stale scan cannot create an assignment after a conflicting
observation commits. The [Worker polling decision](2026-11-20-worker-review-polling.md) applies the same eligibility to existing assignments without changing their ownership.
