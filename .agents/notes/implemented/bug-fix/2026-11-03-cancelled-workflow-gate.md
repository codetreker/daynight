# Agent Note: Cancelled Workflow Gate

Status: implemented

## Problem

The checks workflow cancels an older run when a newer run starts on the same ref.
In [run 41642084148](https://github.com/codetreker/daynight/actions/runs/41642084148/job/125940783493),
the final gate ran after upstream verification was cancelled and reported a
failure. That failure describes an interrupted validation run rather than a
failed validation result.

## Decision

The final `checks` job in the
[workflow](../../../../.github/workflows/checks.yml) uses `!cancelled()` as its
job condition. It still runs after an upstream failure and accepts only
`success` or `skipped` from every preceding job. Workflow cancellation skips a
pending gate and makes a running gate eligible for cancellation.

[GitHub's status-check documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions)
defines `cancelled()` and recommends `!cancelled()` for work that should run
after failures but stop on cancellation. Its
[cancellation reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)
explains how running job conditions are re-evaluated during cancellation.

This changes the cancellation condition from the archived
[CI gate simplification decision](../../archived/simplification/2026-10-21-ci-gate-simplification.md).
Its direct job-result aggregation, version-check timing, and complete validation
workloads remain in effect.

## Alternatives

**Accept cancelled dependencies as successful validation.** Adding `cancelled`
to the accepted results would let an incomplete run report a successful gate.
The result predicate continues to reject anything other than `success` or
`skipped`.

**Keep `always()`.** That condition remains true during workflow cancellation,
allowing a superseded run to execute the gate and produce the observed failure.

## Consequences

Superseded runs remain cancelled. Active runs still expose upstream failures in
the final gate. Concurrency policy, module routing, coverage, acceptance suites,
and cleanup jobs retain their existing behavior. Local syntax and predicate
checks do not reproduce GitHub's scheduler; cancellation behavior relies on the
documented job-condition semantics.
