# Agent Note: APFS Controlled Holder Observation

Status: implemented

## Problem

The controlled APFS recovery case must capture its actual file-holding child in a
volume diagnostic before the child's acknowledged release. A filesystem-only
`lsof` query still considers unrelated processes. It can exceed the diagnostic's
two-second bound without returning the child's PID, even when ordinary image
finalization later succeeds. Successful cleanup does not satisfy that missing
observation, and neither a diagnostic timeout nor cleanup recovery establishes
an infrastructure cause that would justify an unchanged test retry.

The [observation-window decision](2026-10-20-apfs-finalization-window.md) already
samples the volume before inventory and device queries to protect the six-second
holder observation window. The remaining issue is the process scope of that first
sample; the deadline and native evidence requirements remain necessary.

## Decision

The test-only APFS fixture accepts `volumeHolderPid` as an optional known holder
PID for its first Busy volume query. The controlled native case supplies only its owned child's actual PID
after receiving that child's readiness acknowledgement. The query combines
`-p <pid>` with mounted-filesystem selection and `-a`, so both the process and
filesystem must match. Calls without a known PID retain their existing generic
volume query. Current owned-device, raw-alias and `diskutil` diagnostics retain
their existing scope.

Apple's [process selection](https://github.com/apple-oss-distributions/lsof/blob/7a8a1b2a3c0f35c30a5fcd0927f31d441c3e5255/lsof/proc.c#L493-L533)
and [Darwin process traversal](https://github.com/apple-oss-distributions/lsof/blob/7a8a1b2a3c0f35c30a5fcd0927f31d441c3e5255/lsof/dialects/darwin/libproc/dproc.c#L386-L414)
show why a selected PID can exclude unrelated processes before collecting their
open files. The manual defines [`-a` as selection intersection](https://github.com/apple-oss-distributions/lsof/blob/7a8a1b2a3c0f35c30a5fcd0927f31d441c3e5255/lsof/lsof.8#L169-L186)
and [`-p` as PID selection](https://github.com/apple-oss-distributions/lsof/blob/7a8a1b2a3c0f35c30a5fcd0927f31d441c3e5255/lsof/lsof.8#L1339-L1350).
Without `-a`, process and filesystem selections can be combined as alternatives,
which would not establish that the returned child holds this fixture's volume.

Each diagnostic remains bounded by two seconds. The child still acknowledges
release no earlier than six seconds after the first observed Busy. Finalization
retains one absolute 30-second budget, at most three ordinary detach calls, real
Busy, the actual PID in volume output, verified absence of the exact image and
owned-child exit. The original filesystem workload, setup and teardown limits,
one-shot finalization promise and native platform gate remain intact. Timeout
status and bounded stdout/stderr remain observable; missing PID output continues
to fail the controlled case even if image cleanup succeeds.

The [review design](../../../../docs/design/daynight-review.md) owns the fixture
mechanism. The [validation guide](../../../../README.md#validation) owns commands
and source-bound evidence rules. This is a test-fixture diagnostic refinement;
product behavior, attachment ownership and generic diagnostic coverage retain
their existing contracts.

## Alternatives

**Increase the volume diagnostic timeout or shorten the holder lifetime.** More
query time would consume the existing finalization budget, while an earlier
release would reduce the required observation window. The controlled assertion
already knows its only relevant child, so process selection addresses unnecessary
work while retaining both deadlines.

**Filter stdout from a global query.** Filtering can identify a PID only after
`lsof` has collected output; it cannot prevent unrelated process inspection from
exhausting the bound before that output exists.

**Add PID selection without `-a`.** The selectors could admit processes or files
that satisfy only one condition. The required evidence is that this particular
child holds this particular mounted filesystem, so the query must intersect both.

## Consequences

The controlled case observes its acknowledged process directly and preserves the
filesystem condition. Generic cleanup still samples the volume without a PID
filter, so an unknown holder remains investigable. A selected process can itself
be slow or unavailable: this change narrows work but provides no unconditional
two-second latency guarantee and does not treat missing output as absence.

Deterministic tests verify the combined arguments, unchanged generic and device
queries, timeout reporting and preservation of finalization acceptance criteria.
Real macOS execution must still prove actual Busy, PID capture within the same
two-second query bound, release after at least six seconds, ordinary recovery,
exact-image absence and child exit. Simulated commands cannot establish native
latency or a successful platform run. Observed failure and validation receipts
belong to the corresponding PR and CI source revision; this note records no
rolling success history or unexplained transient classification.
