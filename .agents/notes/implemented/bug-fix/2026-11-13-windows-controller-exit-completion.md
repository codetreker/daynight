# Agent Note: Complete Original Windows Controller Process Exit

Status: implemented

## Problem

Windows termination is asynchronous. An empty Job inventory or a changed exit
code can be observed before a previously captured original process handle is
signaled. Returning complete stop at that boundary permits stop-record
publication, recovery or private-resource deletion while the original process
has not finished exiting. A command-line query can also become unavailable
during termination, preventing bootstrap cleanup from reaching its bounded wait.

The existing [native identity mechanism](2026-11-05-windows-native-process-proof.md)
provides full running identity on one process object. The [submitted launch
decision](2026-11-12-submitted-controller-launch.md) supplies original bootstrap
identity and retained Job leases. Neither PID liveness nor repeated command-line
capture alone establishes completion of an original process object's exit.

## Decision

Windows observations enter the native handle path before generic PID liveness
shortcuts. A query-and-synchronization handle first establishes recorded birth.
An authoritative nonexistent PID or a different birth establishes that the
recorded original is gone without acting on a replacement. For a held original,
only `WaitForSingleObject` reporting signaled establishes completed exit.
Running identity retains the full command hash, parent PID and process group
checks. Same-birth identity conflicts, unconfirmed permissions and unknown native
states remain errors.

Changed exit status and the typed `STATUS_PROCESS_IS_TERMINATING` state identify
an exit transition on the birth-verified object. They permit waiting on that
same handle, never a stopped result or a reduced executable-name identity.
Bootstrap cleanup uses its original handle for verification, necessary
termination and completion. An already-terminating original waits without
requesting another termination or depending on an unavailable command line.

A verified running original can begin terminating between identity validation
and `TerminateProcess`. If that call returns Win32 `ERROR_ACCESS_DENIED` (5),
bootstrap rechecks only the same retained handle. A signaled handle proves
completion; changed exit status on an unsignaled handle selects the bounded
wait-only path. `STILL_ACTIVE`, unresolved access denial and unknown state retain
the original termination failure. A failed recheck or subsequent wait keeps that
original error in its chain, and a close failure remains alongside it. This
reconciliation never reopens the PID, substitutes another identity or interprets
access denial alone as successful termination.

Complete Job stopping retains the existing authenticated original Job lease.
Before termination it pins the known original Controller/native process handles
by their recorded birth and verifies full identity for still-running instances.
After termination, all those original handles must be signaled and the same Job
member inventory must be empty. Missing names, missing original leases or an
unproven descendant boundary still refuse complete stop. No new Job framework
or persistent process-handle registry is introduced.

The original absolute deadline governs acquisition, termination and waits;
individual handles and polls do not renew it. A timed native wait derives its
remaining duration from one clock read, rejects a nonpositive duration before
the uint32 call, and caps the positive allowance. Deadline admission and timeout
calculation cannot use separate reads that let a negative duration wrap to
Windows INFINITE. A running kernel call is joined
before releasing its handle. Every acquired process handle is released once,
including partial acquisition, failure and timeout; release failures preserve
both the primary error and each close error. Complete stop records retain their
existing ticket, snapshot, schema and public reason codes and are written only
after the stronger completion check succeeds. POSIX behavior is unchanged.

The [Session protocol](../../../../docs/design/task-session-protocol.md#关闭与清理)
owns caller ordering, durable stop and resource responsibility. Microsoft's
[TerminateProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)
and [TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)
references explain asynchronous termination. The
[WaitForSingleObject](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject)
reference supplies the completion observation on the process handle.

## Alternatives

**Retain PID/ESRCH completion and poll again.** That observation can become
negative before the original handle is signaled. Repeating the same predicate
does not strengthen the exit condition, and a Job member list has the same
completion gap.

**Reopen process identities only after Job termination.** A disappearing PID or
unavailable command line can prevent retaining the exact object that must be
waited on. Pinning the known originals before termination preserves their
completion observations.

**Add a fixed delay or relax the immediate native assertion.** Scheduler and
pending-I/O timing vary. A delay does not prove completion and would leave the resource-lifetime defect
unresolved at the stop boundary.

**Use executable paths or guess missing identity during termination.** Such
fields cannot replace the recorded full identity of a running original or
establish that a numeric PID belongs to it. The wait-only path requires the
recorded birth on the same held object and recognizes only typed exit states.

## Consequences

Successful complete stop now has an observable process-object boundary before
stop publication, recovery and resource release. The existing native regression
retains its immediate zero-time wait assertion after the product stop returns;
its birth-verified handle and separate-process durable readback remain distinct
observations. Controlled kernel-state tests prove transition and error handling;
actual Windows execution is still required to qualify native behavior.

Holding the known originals adds a bounded set of temporary native handles and
makes their release part of the reported operation result. A deadline can refuse
completion while the original is still terminating, preserving resources and
errors for later observation. Native calls remain synchronous and cannot be
forcibly interrupted by a JavaScript timer. This change does not qualify
arbitrary escaped descendants, change POSIX signal policy or repair historical
records that lack the original Job lease or durable stop proof.
