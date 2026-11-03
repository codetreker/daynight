# Agent Note: Cancelled Workflow Gate

Status: implemented

## Problem

When this decision was adopted, the checks workflow cancelled an older run when
a newer run started on the same ref, including `main`.
In [run 41642084148](https://github.com/codetreker/daynight/actions/runs/41642084148/job/125940783493),
the final gate ran after upstream verification was cancelled and reported a
failure. That failure described an interrupted validation run rather than a
failed validation result.

## Decision

The original decision used `!cancelled()` as the final `checks` job condition.
It still ran after an upstream failure and accepted only `success` or `skipped`
from every preceding job. Workflow cancellation skipped a pending gate and made
a running gate eligible for cancellation.

[GitHub's status-check documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions)
defines `cancelled()` and recommends `!cancelled()` for work that should run
after failures but stop on cancellation. Its
[cancellation reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)
explains how running job conditions are re-evaluated during cancellation.

That decision changed the cancellation condition from the archived
[CI gate simplification decision](../../archived/simplification/2026-10-21-ci-gate-simplification.md).
Its direct job-result aggregation, version-check timing, and complete validation
workloads remained in effect.

The [main CI continuity decision](../process/2026-11-03-main-ci-continuity.md)
supersedes the job condition: the gate now uses `always()`, and running `main`
workflows are protected from automatic cancellation by newer pushes.

## Alternatives

**Accept cancelled dependencies as successful validation.** Adding `cancelled`
to the accepted results would let an incomplete run report a successful gate.
The result predicate continued to reject anything other than `success` or
`skipped`.

**Keep `always()`.** That condition remained true during workflow cancellation,
allowing a superseded run to execute the gate and produce the observed failure.
The later continuity decision restores this behavior while changing mainline
concurrency.

## Consequences

The original condition let superseded runs remain cancelled without a separate
gate failure, while active runs still exposed upstream failures. It preserved
concurrency policy, module routing, coverage, acceptance suites, and cleanup jobs.
The linked continuity decision owns the current concurrency and gate conditions;
this note retains the rationale for the earlier cancellation behavior.
