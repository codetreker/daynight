# Agent Note: Main CI Continuity

Status: implemented

## Problem

Mainline validation can still be running when another PR merges. Automatically
cancelling that run interrupts validation of an integrated revision and discards
its remaining verification results.

## Decision

The [checks workflow](../../../../.github/workflows/checks.yml) groups runs by
workflow and ref. Its `cancel-in-progress` expression is false for
`refs/heads/main` and true for PR refs. New mainline pushes wait behind a running
mainline validation; PR updates continue to cancel older runs for the same PR.

The final `checks` job uses `always()` and accepts only `success` or `skipped`
from every dependency. Failed or cancelled dependencies fail the gate. This
supersedes the condition in the
[cancelled workflow gate decision](../bug-fix/2026-11-03-cancelled-workflow-gate.md):
aggregation records incomplete validation, while mainline concurrency protects
the running validation from automatic cancellation.

[GitHub's concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
defines conditional cancellation and the limit of one running and one pending
run per group. Disabling cancellation of the running run does not preserve every
pending run; a newer pending run can replace an older one.

## Alternatives

**Cancel running mainline validation.** This avoids waiting for an earlier
revision, but interrupts its remaining checks whenever another merge occurs.

**Stop aggregation on cancellation.** The previous `!cancelled()` condition
avoided a failed gate on interrupted validation. The gate now always aggregates
dependency outcomes so incomplete verification cannot report a successful gate.

## Consequences

Running mainline validation survives subsequent pushes. New mainline runs can
wait longer, and superseded pending runs can still be cancelled by GitHub.
PR cancellation and all application verification workloads retain their existing
policy. A cancelled PR run can still contain a failed final gate because its
dependencies did not finish successfully.
