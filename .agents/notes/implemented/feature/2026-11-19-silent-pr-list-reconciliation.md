# Agent Note: Silent PR List Reconciliation

Status: implemented

## Problem

New synchronized pull requests can match the current project list while its reader remains on an older snapshot. Requiring a manual refresh delays their visibility, while navigating an anchored page must retain its return path as records change.

## Decision

Reconcile the actual first page without a cursor and publish its records, counts and cursors together. Reconcile later pages with their server-issued cursor. A successful explicit return to a nonempty first-page boundary resumes cursorless reads; empty anchored pages retain their navigation paths. Background reads leave existing content, controls and errors in place while pending. The [PR read design](../../../../docs/design/github-pr-reading.md) describes the client behavior and the unchanged server cursor contract. This builds on the [PR reads decision](../architecture/2026-11-13-github-pr-reads.md).

## Alternatives

**Keep a fixed first-page upper bound and prompt for refresh.** This preserves the old first page but hides newly matched records until a separate user action.

**Jump to the latest first page on every update.** This discards the reader's anchored position and can interrupt navigation through older records.

## Consequences

New matches appear automatically at the first page, while anchored pages remain stable and retain server-provided paths. Membership and counts may change with saved observations. Explicit refresh still returns to the first page, and failed navigation retains a retryable target.
