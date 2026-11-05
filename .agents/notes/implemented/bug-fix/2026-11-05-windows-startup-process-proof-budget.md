# Agent Note: Windows Startup Process Proof Budget

Status: implemented

## Problem

Windows Controller startup and its parent launcher each obtain a process birth
and command-line proof through a fresh PowerShell/CIM query before publishing
ownership. A five-second acquisition limit can terminate both queries on a
loaded host before the Controller binds its authenticated IPC endpoint. The
resulting missing pipe and missing cleanup proof obscure the original startup
failure.

The source-bound [Windows failure](https://github.com/codetreker/daynight/actions/runs/41952251783/job/127001095541)
records the parent query timing out after 5065 ms and the child's matching query
being killed with SIGTERM. The child's journal exists, retains that error, and
has no Controller or native process proof. Parent and child ticket paths agree.
A second [Windows run](https://github.com/codetreker/daynight/actions/runs/41953557410/job/127003024135)
records the same parent timeout after 5070 ms and child startup failure on a
separate runner. Its synthetic merge includes the same unchanged Bot/Controller
code. This establishes a startup acquisition failure independently of the earlier
[fixture teardown isolation](../testing/2026-11-05-bot-fixture-teardown.md)
decision's configuration-restoration race. The log does not establish how long
the killed queries would have needed to complete.

## Decision

`captureProcessProof` owns the startup acquisition default: fifteen seconds on
Windows and five seconds on POSIX. Shared Task/Bot launch, Controller self-proof,
native spawn, independent launch and resume use that same owner. Explicit caller
budgets remain authoritative. The Windows value agrees with the existing Bot CLI
probe's acquisition allowance.

`inspectProcessProof` explicitly uses five seconds for identity recapture. A
startup allowance therefore does not extend each recurring liveness or cleanup
inspection. PID validation, timestamp representation, full command-line hashing,
process groups and Windows Job Object evidence remain unchanged. Failed queries
propagate their original errors; they never produce an empty or invented proof.
Authenticated IPC remains the readiness authority, and unknown launch submission
never authorizes another process or deletion of an unproven process.

The real Bot fixture allows sixty seconds to observe readiness after interrupted
parent acquisition, covering the child's sequential proof, Job setup and native
proof phases. Cleanup allows thirty seconds to observe the child's durable
Controller proof, covering self-acquisition and Job setup. Its joined 180-second
teardown hook remains the owner of resource release.

## Alternatives

**Extend every identity observation.** Repeated inspection is a separate
operation from acquiring a new writer. Raising its budget would extend cleanup
and recovery queries without addressing an additional observed failure.

**Replace CIM with native process APIs.** GetProcessTimes provides a documented
birth timestamp, but QueryFullProcessImageName supplies an executable path rather
than the full command line used by the persisted proof. [Native command-line querying](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntqueryinformationprocess)
adds an internal API dependency and
[CIM timestamp-format considerations](https://learn.microsoft.com/en-us/windows/win32/wmisdk/cim-datetime).
This requires its own evidence and ownership review; it is unnecessary to keep
the existing proof contract with a bounded startup allowance.

**Treat an absent pipe or missing proof as successful cleanup.** Neither proves
that the originally submitted process and its descendants stopped. That would
discard the evidence needed for safe reconciliation.

## Consequences

Cold Windows acquisition can use ten additional seconds per query. Permanently
unavailable queries still fail after a finite bound and retain responsibility.
Fifteen seconds is a selected startup policy, not a guarantee that every hosted
query finishes within it. POSIX capture and recurring inspection retain their
existing limits.

Virtual-time regressions make a six-second CIM acquisition succeed during
startup, retain the original timeout error for explicit and recurring
five-second observations, and prevent Job assignment when proof acquisition
fails. Native Bot integration still requires one authenticated writer, no user
initialization turn, and complete ownership-verified teardown.
