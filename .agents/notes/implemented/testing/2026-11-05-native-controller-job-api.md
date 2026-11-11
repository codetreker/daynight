# Agent Note: Native Controller Job Object Calls

Status: implemented

## Problem

Real Windows Bot recovery and deletion repeatedly create Controller generations,
stop their process trees and independently confirm original process identities
and Job membership. The Job bridge starts PowerShell and compiles a C# helper for
every create, query and termination. This repeated initialization adds cost to
both product lifecycle operations and the tests that prove them. Reducing the
number of generations or replacing OS evidence would weaken those regressions.

## Decision

Controller Job operations use the existing Koffi dependency to call Win32 in the
calling process. Native function bindings are loaded lazily and reused. The
original optimization preserved the existing create/assign/close and
open/query/close lifetimes and did not add kill-on-close. It interpreted
`ERROR_FILE_NOT_FOUND` as an empty inventory and retained errors for access,
query, termination and release failures. Its fifteen-second budget applied
between native calls; an in-progress kernel call could not be preempted.

A Job object's body and its namespace name have different lifetimes: the
[CreateJobObjectW contract](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw)
keeps its body until handles and member processes are gone, while a
[temporary object's name](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/nf-wdm-zwmaketemporaryobject)
is removed when its final handle closes. The optimization did not establish a
persistent Job-name owner. Its Windows regression held a separate fixture handle
so that the membership and termination checks exercised an existing Job.

The [Controller Job ownership decision](../bug-fix/2026-11-11-windows-controller-job-ownership.md)
replaces that handle lifetime and missing-name interpretation with an independent
guardian, exact object ownership and a durable stop receipt. Koffi remains the
native call boundary; the original benchmark and fixture do not prove the new
production ownership path.

## Alternatives

**Keep per-operation PowerShell compilation.** It preserves the existing bridge
but repeats executable and compiler initialization for each independent safety
check. The existing native dependency already exposes the required Win32 calls.

**Reduce generations or mock process ownership in Bot integration.** This would
reduce runtime while removing the real multi-generation and OS cleanup proof
that makes the regressions useful.

**Reuse the Bot capability-probe lease.** Its retained handle and kill-on-close
policy would alter Controller lifetime and stopping behavior. Sharing that lease
would combine separate resource owners to obtain a performance change.

## Consequences

Repeated Job operations avoid shell startup and C# compilation. The original
optimization retained the then-existing stop confirmation and error paths. Native library
loading still contributes once per process; real Controller/native startup,
SQLite journals, IPC and Git fixture work remain costs.

Linux Docker can verify layouts, errors and surrounding lifecycle isolation but
cannot execute kernel32. Windows performance claims require actual Windows
measurements. Case totals, parallel file time, suite time and overall CI time
have different boundaries; reducing these Bot cases does not establish an equal
improvement in the repository's browser-dominated CI completion time.
