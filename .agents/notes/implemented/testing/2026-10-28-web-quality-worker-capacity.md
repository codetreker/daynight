# Agent Note: Web Quality Worker Capacity

Status: implemented

## Problem

The complete Web Vitest/V8 command runs near its existing 180-second deadline.
Its worker budget was selected while coverage shared a four-CPU runner with
Docker preparation. Quality now has a dedicated runner, so retaining that
contention reserve can leave available CPU unused without reducing the required
coverage workload.

## Decision

The coverage child in `scripts/ci.mts quality` receives
`VITEST_MAX_WORKERS=4`. The Node harness still runs first and retains its own
180-second deadline. Coverage retains its separate 180-second deadline, `forks`
pool, per-file isolation, complete product-source inventory, original assertions
and strict unrounded statement-coverage gate.

This budget targets the repository's public `ubuntu-latest` quality job. The
[GitHub runner specification](https://github.com/github/docs/blob/2853a7b4a1bd4e17da2a43cf2c8d7306d7d4a431/data/reusables/actions/supported-github-runners.md#L18-L28)
assigns that standard Linux runner four CPUs and 16 GB RAM. This is a fixed budget
for that documented job, not a claim that four workers is optimal on arbitrary
hosts. Quality runs without browser or Docker preparation on the same runner,
as established by the [quality isolation decision](2026-10-26-web-quality-job-isolation.md).

A controlled complete-suite comparison restricted both executions to four CPUs
and kept identical test inputs, `forks`, file isolation, V8 collection and the
strict checker. Two workers completed in 163.87 seconds; four completed in 99.54
seconds. Both passed the complete suite and coverage gate. The source-bound
receipts belong to [PR #269](https://github.com/codetreker/daynight/pull/269);
those local results do not establish later hosted duration.

The [archived efficiency decision](../../archived/testing/2026-10-21-ci-validation-efficiency.md)
retains the original two-worker comparison with concurrent uncached Docker work.
Its contention premise explains the historical choice; separate quality runners
remove that premise. This decision calibrates the existing worker setting and
does not change workflow routing, job bounds or browser execution.

## Alternatives

**Keep two coverage workers.** The controlled complete run passes at 163.87
seconds, but the original budget reserved capacity for a concurrent build that
no longer shares this runner. Four workers use its additional capacity and
provide more command-deadline headroom in the matched comparison.

**Batch routing assertions or run routing under the Node environment.** All 15
routing cases and exact raw counters for all 142 covered product files were
retained in controlled Vitest/V8 probes. Batched execution measured 34.0 seconds
against a 34.73-second baseline; the Node environment with no setup files
measured 34.40 seconds. These results do not demonstrate a useful saving that
justifies changing the existing assertion or coverage environment.

**Switch coverage to the threads pool.** A complete two-thread probe measured
169.22 seconds and did not pass one status test. It did not
establish a faster complete passing result or justify changing the existing
fork isolation contract. Worker-count calibration leaves the pool unchanged.

## Consequences

The quality command can use its dedicated standard runner's four CPUs while
preserving every command, coverage, process-group cleanup and browser gate.
The browser job still owns its complete native/container/capacity journey with
one browser worker and zero retries. No shards, input reductions or larger
allowances are introduced.

More concurrent test processes can increase peak memory and expose shared test
resources. The configured runner capacity and matched complete-suite comparison
bound this choice; a future runner or workload change requires a fresh comparison.
Local speed measurements do not identify a particular hosted machine's CPU or
scheduling behavior and do not guarantee later hosted duration. A command or
cleanup timeout remains a failure requiring diagnosis.
