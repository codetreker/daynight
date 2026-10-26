# Agent Note: Web coverage resource admission

Status: implemented

## Problem

The Web job has bounded harness and Vitest/V8 commands, but their original
admission allowed the complete coverage command to overlap native production
preparation and the normal dev-ci image build. As the required test workload
grows, completion inside the command bound depends on preparation conditions
that the pipeline does not express. A deadline expiry after test files report
success is still an incomplete coverage gate; it does not establish a failed
assertion, a particular CPU or I/O cause, or a transient infrastructure failure.

The pipeline needs explicit admission conditions for coverage while preserving
the complete workload, deadlines, browser permissions and cancellation ownership.

## Decision

The coverage callback receives a lazy `waitForPreparations()` operation. CI runs
the existing Node harness first, while native and container preparation continue,
then awaits that operation before starting the unchanged Vitest/V8 command and
strict statement checker. The gate waits for native preparation and the
container's validated prepared state, not its complete lifecycle.

The runner reuses the atomic `container/ready.json` record and existing
run/source/process validation. The internal `containerPrepared()` phase delegates to
`waitForContainerPreparation()` in the runner, which validates the recorded and
live callback against that identity. The requested wait is recorded as the
`container-preparation` stage and raced against container exit, so an early exit
cannot leave coverage waiting indefinitely. Readiness observation starts only when the coverage
callback requests the gate. The normal local acceptance callback ignores it and
retains its existing schedule; no new CLI parameter or producer protocol is
introduced.

Prepared state admits coverage only. It does not grant container browser
permission. Native functional checks and browser cleanup still precede the
existing atomic `container-permission.json` release. Waiting for the whole
container stage before coverage would create a cycle: container browser work
waits for native functional cleanup, which waits for browser preparation, which
waits for successful coverage.

Both required quality commands retain separate 180-second bounds. Coverage keeps
`VITEST_MAX_WORKERS=2`, the `forks` pool, per-file isolation and the complete
statement gate. Browser installation still starts after both commands pass and
keeps its 600-second bound. The container permission wait remains 900 seconds,
the job remains bounded at 20 minutes, and every browser, capacity, geometry,
retry, receipt and cleanup requirement remains in force.

Failure or cancellation wakes admission waits, cancels dependent work and drains
all started phases. Capacity remains last, after functional work, all preparation
and commands, complete container cleanup and browser recovery. The
[acceptance pipeline decision](2026-10-21-web-acceptance-pipeline.md) continues to
own those lifetimes and evidence; this decision partially supersedes its CI
coverage/preparation overlap. The original
[two-worker rationale](2026-10-21-ci-validation-efficiency.md) remains applicable.

## Alternatives

**Retain full coverage/preparation overlap.** It can hide preparation time, but
does not make coverage's admitted preparation conditions explicit. The complete
command, including V8 report generation and the strict checker, must finish
inside its bound; successful test-file messages alone cannot replace that result.

**Wait for complete container acceptance.** This would serialize more than the
required preparation and create the browser-permission dependency cycle. The
existing prepared record identifies the earlier boundary without changing its
producer or admitting container browsers early.

**Increase the command allowance.** A larger bound changes the acceptance budget
without expressing the preparation dependency. The selected change preserves
the existing limits and workload, and changes only the point at which coverage
may begin.

## Consequences

The harness retains preparation overlap, while CI coverage begins after both
owned preparations reach their defined boundary. This makes the scheduling
condition testable without adding a general resource scheduler or changing
default local acceptance behavior. Tests must distinguish container preparation
from completion, exercise early exit and cancellation, and retain later browser
permission and capacity ordering checks.

The gate does not prove that host resource contention caused a particular
deadline failure, nor guarantee a faster hosted run. CPU/I/O saturation and
elapsed-time effects require their own measurements. Actual CI outcomes remain
bound to the tested source, workload and runner; unchanged failures are not
retried without establishing a transient cause. The existing command and job
deadlines remain failure bounds, not performance promises.
