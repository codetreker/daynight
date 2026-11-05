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

The isolation decision introduced separate `verify-web-quality` and `verify-web`
responsibilities. The [case-shard decision](2026-11-04-web-ci-case-shards.md)
subsequently partitions the browser responsibility into two matrix entries;
quality remains a separate job. Each entry keeps a 20-minute bound, and the
existing final `checks` job requires selected Web jobs to succeed and validates
the complete shard union. Shared workflow changes retain all-module selection.

`scripts/ci.mts` exports `runCi(mode, cancellation, operations?, shard?)` for explicit
internal `quality` and `browser` modes. Quality runs
the canonical Node harness, complete Vitest/V8 collection and strict statement
checker serially. Harness has a 180-second deadline and collection has a 300-second deadline; the
[stage budget decision](2026-11-04-web-coverage-finalization-budget.md) gives
final inventory and coverage verification an independent 60-second deadline.
Only the Vitest/V8
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

**Increase the job or command allowance.** Larger budgets change the validation
contract without separating the competing responsibilities. The isolation decision kept both jobs at
20 minutes and preserved their command and functional deadlines. The later
[stage budget decision](2026-11-04-web-coverage-finalization-budget.md) separately
bounds final verification and calibrates collection for the larger suite.

**Shard browser scenarios across runners.** At the time of this choice, shards
would duplicate target preparation and require scenario/artifact aggregation,
so the full browser journey remained together and only independent quality work
received a separate job. Capacity later moved to the explicit local stress path.
The [case-shard decision](2026-11-04-web-ci-case-shards.md) accepts two independent
browser runners with validation in the existing final gate; quality isolation
and its command budgets remain in force.

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
failure bounds. The [bounded CI retry decision](../process/2026-11-05-bounded-ci-retries.md)
replaces the original requirement to prove a transient cause before rerunning an
unchanged failure; isolation itself does not establish that cause.
