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
serially, with a separate 180-second deadline for each command. Only the coverage
child receives `VITEST_MAX_WORKERS=2`; its `forks` pool, file isolation and full
product-source manifest remain unchanged.

Browser mode installs pinned Chromium with Linux dependencies under the existing
600-second bound, then invokes ordinary core acceptance. That runner owns native
and container preparation, functional browser order, atomic permission release,
capacity, recovery and cleanup. It has no quality/browser preparation callbacks,
empty success phases or readiness-admission observer. Local acceptance continues
to use its preinstalled browser through the same ordinary core. The existing
`ready.json` remains diagnostic; it does not grant browser execution.

`runCiCommand` retains process ownership after each managed command settles.
`requireGroupStopped` verifies that its owned process group has stopped, even
when the command leader exited successfully. A command failure, cancellation or
process-group cleanup failure remains a failure; combined errors are preserved.
This guard is not replaced by the command leader's exit status.

The container's 900-second permission wait, native-before-container browser
release, one browser worker, zero retries, complete capacity inputs and all
geometry/performance thresholds remain unchanged. Within browser acceptance,
capacity waits for its own preparation, functional phases, complete container
cleanup and browser recovery. Quality runs on a separate runner and does not
alter those timing conditions. Artifacts keep their quality or acceptance
ownership, source identity and retention policy.

This partially supersedes the unified quality/browser orchestration in the
[acceptance pipeline decision](../../archived/testing/2026-10-21-web-acceptance-pipeline.md). The target,
permission, resource and recovery rules remain unchanged and are defined in the
[Web README](../../../../packages/daynight-web/README.md#production-browser-acceptance). The original
[two-worker rationale](../../archived/testing/2026-10-21-ci-validation-efficiency.md) remains applicable
to the quality command without claiming a universal fastest worker setting.

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
contract without separating the competing responsibilities. Both jobs retain
20 minutes, and all existing command and functional deadlines remain in force.

**Shard browser scenarios across runners.** Shards duplicate target preparation
and require new scenario, artifact and permission aggregation. The full native,
container and capacity journey remains together; only independent quality work
has a separate job.

## Consequences

Quality and browser validation have independent runner resources and explicit
job results. The workflow cannot pass if either selected job fails or is
cancelled. The core acceptance runner expresses only its actual browser and
resource dependencies, and local use gains no new quality work or preparation
wait. Internal CI modes do not add a product CLI or deployment interface.

This costs a second Node/pnpm setup and a separate quality artifact upload. It
does not omit tests, weaken the strict coverage comparison, bypass process-group
cleanup or replace protected merge checks. Wrapper tests cover full commands and
errors; core tests retain native/container ordering, permission and capacity
ownership without obsolete quality placeholders.

Isolation does not establish the CPU/I/O cause of an earlier timeout or guarantee
a faster hosted run. Actual completion and elapsed-time observations remain
bound to the tested source, workload and runner. The existing deadlines remain
failure bounds, and unchanged failures are retried only after a transient cause
is established.
