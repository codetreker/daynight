# Agent Note: Windows Oracle Phase Evidence

Status: implemented

## Problem

The independent Windows ACL and CIM test oracles can reach their process
deadlines without showing which operation started. In
[Windows shard 1](https://github.com/codetreker/daynight/actions/runs/44331274421/job/134896746962)
at `76419a7d20c8b1e6dbfc3638c03a70c9c1267815`, the ACL readback closed with
SIGKILL after its 30-second allowance, and the later CIM command closed with
SIGTERM after 60,561 ms. Both retained empty stdout and stderr. Native store
operations and native process identity assertions had already succeeded.

The shell lifetimes did not overlap. Other tests continued during the ACL
deadline, but the artifacts contain no shell phase or resource observation that
establishes a shared runner condition. The adjacent passing job used image
`20261103.298.1`; the failed job used `20261116.315.1`, with different OS builds
and regions but the same Node.js 24.22.3. Those differences are correlation,
not evidence that an image update caused the stalls. Neither a startup cause nor a slow ACL or
CIM operation can be inferred from empty output. The earlier
[ACL budget decision](2026-11-10-windows-session-acl-probe-budget.md) records the
same distinction for a previous failure.

## Decision

The bounded command runner retains process lifecycle events and incremental
script checkpoints. The original ACL and CIM PowerShell scripts marked entry
before their work and bracketed their respective operations. Command identity,
elapsed time, the last observed phases, partial output and exit/close observations
remain available when a command fails. Output retained for diagnostics is bounded.
The unused command input is closed explicitly.

After a later ACL timeout without script entry, the
[native ACL observer decision](2026-11-19-native-windows-acl-observer.md)
replaces only private ACL readback with an independent test helper. The real
icacls public ACE grant retains its 30-second allowance and the CIM command
retains 60 seconds with script checkpoints. A timeout is a failure, with process
termination and closure joined; there are no retries or substituted oracle
results. The protected single-user DACL observation, real public ACE grant and
rejection, native self/parent proof, running-state inspection, complete Unicode
CIM comparison and handle/fixture cleanup retain their original responsibilities.

The confirmed defect addressed here is missing failure-stage evidence. The
historical stalls' inner cause remains unknown; a successful later run cannot
establish it. A future timeout can distinguish a shell that never reached script
entry from a query, conversion or process-lifecycle failure before a causal
repair is selected.

## Alternatives

**Raise the process deadlines again.** The previous ACL increase already
recurred without revealing a sufficient allowance or the delayed operation.
Another increase would postpone failure while preserving the evidence gap.

**Replace the oracles with production native helpers.** This would make the
implementation validate its own DACL and process identity interpretation,
removing the independently observed Windows formats.

**Retry empty-output commands.** A later success would discard the failed
observation without explaining it and could conceal repeatable failures.

## Consequences

Real Windows tests continue to validate the same permissions and process
identity. Failure artifacts can localize later stalls while their original
deadlines remain finite. Script checkpoints and bounded command diagnostics add
test-only maintenance and output. They do not prove a historical startup,
provider, runner scheduling or input-stream cause, and do not change production
process or ACL behavior.
