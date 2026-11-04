# Agent Note: Web quality job isolation

Status: implemented

## Problem

The Web workload combines bounded harness and Vitest/V8 checks with real native
and container browser acceptance. Running them in one hosted job makes quality
and build preparation compete for one runner and consumes one job budget even
when individual commands pass. Successful test-file messages do not establish
that coverage reporting and its strict checker completed; successful individual
phases do not establish that the entire job completed.

The workflow needs explicit execution and budget ownership for both kinds of
validation while preserving every assertion, command deadline, browser
permission, performance budget and cleanup requirement. A deadline failure alone
does not identify a particular CPU or I/O cause or prove transient infrastructure.

## Decision

The existing Web module selector enables two parallel jobs: `verify-web-quality`
and `verify-web`. Each keeps a 20-minute job bound, and the final `checks` job
requires both alongside all other selected modules. Shared workflow changes
retain the existing all-module selection rule. This separates responsibilities,
not browser scenarios or product scope.

`scripts/ci.mts` exports `runCi(mode, cancellation, operations?)` for explicit
internal `quality` and `browser` modes. Quality runs
the canonical Node harness and complete Vitest/V8 plus strict statement checker
serially. The harness retains 180 seconds; coverage has a separate 240-second
deadline under the [coverage budget decision](2026-11-04-web-coverage-command-budget.md).
Isolation originally retained 180 seconds for each command. Only the coverage
child receives `VITEST_MAX_WORKERS=4`, calibrated for its dedicated public
standard Linux runner by the [worker capacity
decision](2026-10-28-web-quality-worker-capacity.md); its `forks` pool, file
isolation and full product-source manifest remain unchanged.

Browser mode installs pinned Chromium with Linux dependencies under the existing
600-second bound, then invokes ordinary core acceptance. That runner owns native
and container preparation, atomic permission release, recovery and cleanup.
The [functional target decision](2026-11-04-web-functional-target-overlap.md)
replaces the original native-before-container functional browser order with
concurrent isolated targets and a shared CLI cleanup barrier. The [local stress decision](2026-11-03-local-stress-suites.md)
partially supersedes the original mandatory capacity phase: ordinary CI runs the
complete functional inventory, while explicit local stress acceptance adds
capacity after the same preparation and cleanup barriers. It has no quality/browser preparation callbacks,
empty success phases or readiness-admission observer. Local acceptance continues
to use its preinstalled browser through the same ordinary core. The existing
`ready.json` remains diagnostic; it does not grant browser execution.

`runCiCommand` retains process ownership after each managed command settles.
`requireGroupStopped` verifies that its owned process group has stopped, even
when the command leader exited successfully. A command failure, cancellation or
process-group cleanup failure remains a failure; combined errors are preserved.
This guard is not replaced by the command leader's exit status.

The container keeps its 900-second permission wait and source/run binding.
Permission now follows native preparation so the independent functional targets
can overlap; each retains one browser worker and zero retries. Explicit local
stress acceptance retains complete capacity inputs and all geometry/performance
thresholds. Its capacity phase waits for preparation, functional phases,
complete container cleanup and browser recovery. Quality runs on a separate
runner and does not alter those local timing conditions. Artifacts keep their quality or acceptance
ownership, source identity and retention policy.

This partially supersedes the unified quality/browser orchestration in the
[acceptance pipeline decision](../../archived/testing/2026-10-21-web-acceptance-pipeline.md). The target,
permission, resource and recovery rules remain unchanged and are defined in the
[Web README](../../../../packages/daynight-web/README.md#production-browser-acceptance). The original
[two-worker rationale](../../archived/testing/2026-10-21-ci-validation-efficiency.md)
compared coverage with concurrent Docker preparation. The isolation decision
initially retained that worker budget. The [worker capacity
decision](2026-10-28-web-quality-worker-capacity.md) recalibrates the existing
coverage setting for its dedicated runner; the archived comparison retains its
historical contention conditions rather than prescribing the current budget.

## Alternatives

**Keep quality and browser preparation on one runner.** It can hide some setup
time, but shares both preparation conditions and one job budget. The complete
quality report, browser targets, capacity and cleanup all remain required, so
successful child output cannot substitute for whole-job completion.

**Gate coverage on prepared state inside the same job.** A lazy gate was
considered to keep harness overlap while waiting for native and container
preparation before coverage. It makes that resource condition explicit, but
keeps quality and browser work on one job's critical path and adds an observer
that ordinary acceptance does not need. Separate jobs remove that coupling;
the selected core has no such gate or reader.

**Increase the job or command allowance.** At the time of isolation, larger
budgets would have changed the validation contract without separating the
competing responsibilities. Both jobs retained 20 minutes and their existing
command and functional deadlines. The later
[coverage budget decision](2026-11-04-web-coverage-command-budget.md) addresses
ordinary-suite growth on the already separate quality runner; it does not
replace isolation or increase either job's bound.

**Shard browser scenarios across runners.** Shards duplicate target preparation
and require new scenario, artifact and permission aggregation. At the time of this choice, the full native, container and capacity journey
remained together; only independent quality work received a separate job.
Capacity now belongs to the explicit local stress path.

## Consequences

Quality and browser validation have independent runner resources and explicit
job results. The workflow cannot pass if either selected job fails or is
cancelled. The core acceptance runner expresses only its actual browser and
resource dependencies, and local use gains no new quality work or preparation
wait. Internal CI modes do not add a product CLI or deployment interface.

This costs a second Node/pnpm setup and a separate quality artifact upload. It
does not omit tests, weaken the strict coverage comparison, bypass process-group
cleanup or replace protected merge checks. Wrapper tests cover full commands and
errors; core tests retain native/container ordering, permission, optional local
capacity ownership and cleanup without obsolete quality placeholders.

Isolation does not establish the CPU/I/O cause of an earlier timeout or guarantee
a faster hosted run. Actual completion and elapsed-time observations remain
bound to the tested source, workload and runner. The existing deadlines remain
failure bounds, and unchanged failures are retried only after a transient cause
is established.
