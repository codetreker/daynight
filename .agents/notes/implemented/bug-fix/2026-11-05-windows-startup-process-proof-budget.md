# Agent Note: Windows Startup Process Proof Budget

Status: implemented

## Problem

The original Windows Controller startup and parent launcher each obtained a
process birth and full command-line proof through a fresh PowerShell/CIM query
before publishing ownership. A five-second acquisition limit could terminate
both queries on a loaded host before the Controller bound its authenticated IPC
endpoint. The resulting missing pipe and missing cleanup proof obscured the
original startup failure.

The source-bound [Windows failure](https://github.com/codetreker/daynight/actions/runs/41952251783/job/127001095541)
records the parent query timing out after 5065 ms and the child's matching query
being killed with SIGTERM. The child's journal exists, retains that error, and
has no Controller or native process proof. Parent and child ticket paths agree.
A second [Windows run](https://github.com/codetreker/daynight/actions/runs/41953557410/job/127003024135)
records the same parent timeout after 5070 ms and child startup failure on a
separate runner. Its synthetic merge includes the same unchanged Bot/Controller
code. This established a startup acquisition failure independently of the
[fixture teardown isolation](../testing/2026-11-05-bot-fixture-teardown.md)
decision's configuration-restoration race. The logs did not establish how long
the killed queries would have needed to complete.

## Decision

`captureProcessProof` owns the startup acquisition default: fifteen seconds on
Windows and five seconds on POSIX. Shared Task/Bot launch, Controller self-proof,
native spawn, independent launch and resume use that same owner. Explicit caller
budgets remain authoritative. The Windows value originally matched the Bot CLI
probe's acquisition allowance and allowed PowerShell/CIM initialization more
time without extending recurring observations.

`inspectProcessProof` explicitly uses five seconds for identity recapture. PID
validation, timestamp representation, full command-line hashing, process groups
and Windows Job Object evidence remain required. Failed acquisition propagates
its original error; it never produces an empty or invented proof. Authenticated
IPC remains the readiness authority, and unknown launch submission never
authorizes another process or deletion of an unproven process.

The [native Windows proof decision](2026-11-05-windows-native-process-proof.md)
replaces the PowerShell/CIM acquisition implementation after the same failure
recurred beyond fifteen seconds. It retains these caller budgets and ownership
rules while checking the deadline between native calls; an in-progress kernel
call cannot be preempted by a JavaScript timer.

The real Bot fixture allows sixty seconds to observe readiness after interrupted
parent acquisition, covering the child's sequential proof, Job setup and native
proof phases. Cleanup allows thirty seconds to observe the child's durable
Controller proof, covering self-acquisition and Job setup. Its joined 180-second
teardown hook remains the owner of resource release.

## Alternatives

**Extend every identity observation.** At the budget decision, repeated
inspection was a separate operation from acquiring a new writer. Raising its
budget would have extended cleanup and recovery queries without addressing an
additional observed failure.

**Replace CIM with native process APIs.** At the budget decision,
GetProcessTimes offered a documented birth timestamp, but
QueryFullProcessImageName supplied an executable path rather than the full
command line used by the persisted proof. [Native command-line querying](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntqueryinformationprocess)
added an internal API dependency and
[CIM timestamp-format considerations](https://learn.microsoft.com/en-us/windows/win32/wmisdk/cim-datetime).
That evidence and ownership work was deferred while a bounded allowance kept
the existing proof implementation. The later native decision records why the
recurrence justified that dependency and how full identity is retained.

**Treat an absent pipe or missing proof as successful cleanup.** Neither proves
that the originally submitted process and its descendants stopped. That would
discard the evidence needed for safe reconciliation.

## Consequences

The original allowance gave cold Windows acquisition ten additional seconds per
query, with permanently unavailable queries still failing and retaining
responsibility. Fifteen seconds was a selected startup policy, not a guarantee
that every hosted query would finish within it. The subsequent native decision
removes that initialization dependency. POSIX capture and recurring inspection
retain their existing limits.

The budget decision's virtual-time regressions exercised six-second CIM
acquisition, original timeout errors for explicit and recurring five-second
observations, and refusal to assign a Job when acquisition failed. Native proof
regressions now own the replaced acquisition implementation. Real Bot integration
continues to require one authenticated writer, no user initialization turn, and
complete ownership-verified teardown.
