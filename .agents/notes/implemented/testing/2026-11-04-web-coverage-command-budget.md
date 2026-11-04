# Agent Note: Web Coverage Command Budget

Status: implemented

## Problem

The complete ordinary Web suite can finish its file assertions close to the
coverage command's deadline while V8 reporting and the strict statement checker
still need to run. Passing file messages cannot establish a complete coverage
result. A deadline with negligible remaining time can prevent new correctness
regressions from completing the same required gate.

The [mainline quality run](https://github.com/codetreker/daynight/actions/runs/41793268536/job/126452016830)
passed 166 files and 3,186 tests, reported a Vitest duration of 176.72 seconds,
and completed the strict checker. The
[Session history quality run](https://github.com/codetreker/daynight/actions/runs/41794777346/job/126456282977)
printed passing results for all 168 files but was terminated by the 180-second
command timer before the coverage summary and checker completed. Those runs
show insufficient headroom; they do not isolate the CPU or I/O cause, prove
transient infrastructure, or attribute the whole difference to two new files.

## Decision

Only `test:coverage` in `scripts/ci.mts quality` receives a 240-second command
deadline. It still runs the complete ordinary Vitest/V8 suite followed by the
strict unrounded statement checker. The Node harness keeps its independent
180-second deadline. Four coverage workers, the `forks` pool, per-file isolation,
the complete product-source manifest and `covered * 10 > total * 9` remain
unchanged. Stress workloads remain outside ordinary CI discovery.

The [quality isolation decision](2026-10-26-web-quality-job-isolation.md) continues
to own separate quality/browser jobs and process-group cleanup. Both jobs retain
their 20-minute bounds. Browser installation, navigation and functional
acceptance deadlines are unaffected. The
[worker capacity decision](2026-10-28-web-quality-worker-capacity.md) continues
to own the four-worker setting and its original comparison.

The additional minute gives the complete coverage command room to finish its
report and checker without changing test outcomes into success. Command errors,
cancellation, missing coverage artifacts and failure to stop owned process
groups still fail validation. A successful run must produce the full report
and strict checker result before delivery can pass.

## Alternatives

**Keep 180 seconds and repeat the failed run.** The successful comparison already
uses nearly all of that allowance. No transient cause was established, and
passing file messages do not justify retrying unchanged work or omitting the
remaining coverage phases.

**Allow 300 seconds.** This would provide another minute, but the observed failure
does not establish a need for that larger allowance. The 240-second choice
changes only the measured command boundary; later failures still require
diagnosis rather than automatic increases.

**Change worker count or reduce validation work.** The worker count is already
calibrated for the dedicated runner. Changing concurrency, isolation, discovery
or coverage inventory would need separate evidence and alter more than the
command budget needed to complete these correctness regressions.

## Consequences

This relaxes the coverage command's elapsed-time failure bound by one minute;
it does not lower coverage thresholds or remove assertions. A genuinely stuck
coverage command can therefore take up to one minute longer to reach timeout.
Cancellation and the existing termination/cleanup behavior remain available.

The observed runs do not guarantee that every future workload completes within
240 seconds. Hosted duration and complete artifacts must still be checked for
the actual revision. This decision adds no retry policy, CI sharding, test-pool
migration or general repository optimization. The
[Web README](../../../../packages/daynight-web/README.md#validation-and-build)
owns the runnable validation commands and their current bounds.
