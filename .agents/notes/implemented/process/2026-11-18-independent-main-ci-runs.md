# Agent Note: Independent Main CI Runs

Status: implemented

## Problem

Each integrated revision needs its own `checks` and shell/browser validation.
Disabling cancellation for a shared main concurrency group protects a running
workflow but does not protect its pending successor: a later run can replace it
before any job starts.

## Decision

Both workflows were grouped by workflow name, ref, full commit SHA and run ID.
Every independent trigger, including a manual run of the same commit, had its
own group. Main runs retained `cancel-in-progress: false`; other refs retained the
workflow/ref group and their existing cancellation policy. PR updates therefore
continued to supersede earlier runs for the same PR. The later
[bounded main CI decision](2026-11-19-bounded-main-ci-runs.md) replaces this
grouping policy to limit runner backlog.

This replaces the grouping policy in the archived [main CI continuity decision](../../archived/process/2026-11-03-main-ci-continuity.md).
That decision protected running main validation and explicitly acknowledged
that pending runs could still be replaced. The final gate's treatment of failed
or cancelled dependencies remains unchanged.

## Alternatives

**Keep the shared main group without cancelling running workflows.** It protects
the active run but still lets a later pending run replace another pending run.

**Use a shared queue.** GitHub's bounded queue can still reject runs when full,
and would retain a shared waiting position rather than give each trigger an
independent group.

## Consequences

Under this decision, later main triggers could not replace or automatically
cancel an earlier run through these workflow concurrency groups. Independent
runs could compete for runner capacity; group isolation did not guarantee
immediate job start or successful execution. Trigger selection, validation
suites and result aggregation were unchanged.
