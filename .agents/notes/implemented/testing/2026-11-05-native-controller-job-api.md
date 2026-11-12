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
calling process. Native function bindings are loaded lazily and reused. Creation
retains the original name validation, noninheritable handles, process assignment
and handle release. Inspection opens with query access, adding terminate access
only for a stop request. The original termination queried membership after
using exit code 1; the [submitted launch identity decision](../bug-fix/2026-11-12-submitted-controller-launch.md)
supersedes that ordering with same-handle ownership verification and bounded
waiting. The [exit completion decision](../bug-fix/2026-11-13-windows-controller-exit-completion.md)
requires known original process handles to be pinned before termination and
signaled before successful complete stop; it preserves this Job API and its
member inventory checks. No breakaway or kill-on-close policy is added.

The original implementation treated `ERROR_FILE_NOT_FOUND` as an empty inventory;
the [submitted launch identity decision](../bug-fix/2026-11-12-submitted-controller-launch.md)
supersedes that assumption because a live Job can lose its name. Access denial,
duplicate creation, native failures and malformed process IDs remain errors.
Membership decoding checks the bounded buffer against the native
pointer width and reported counts. Owned handles are released on success and
failure; simultaneous operation and release failures retain both errors and the
original cause. The fifteen-second operation budget includes lazy loading and
native work. Checks between calls and after handle release reject late results;
a synchronous kernel call already in progress must finish before release.

The original design kept create/assign/close and open/query/close lifetimes;
the replacement retains the Controller and observer handles through the
corresponding execution. A Job object's body and its namespace name have different lifetimes: the
[CreateJobObjectW contract](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw)
keeps its body until handles and member processes are gone, while a
[temporary object's name](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/nf-wdm-zwmaketemporaryobject)
is removed when its final handle closes. This optimization does not establish a
new persistent Job-name owner. The Bot capability-probe lease has different
ownership and kill-on-close requirements and remains independent.

Cross-platform regressions exercise native layouts, access masks, failures,
deadlines and handle release. A Windows regression holds its own raw Job handle
while checking actual descendant membership and termination through the public
Controller helpers; this prevents a missing name from substituting for a real
query. Original Bot generation counts, recovery limits, process evidence and
cleanup assertions remain in place. The
[development guide](../../../../docs/development.md#cli-development) owns the
validation commands and interpretation.

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

Repeated Job operations avoid shell startup and C# compilation while preserving
the caller's independent stop confirmations and error paths. Native library
loading still contributes once per process; real Controller/native startup,
SQLite journals, IPC and Git fixture work remain costs.

Linux Docker can verify layouts, errors and surrounding lifecycle isolation but
cannot execute kernel32. Windows performance claims require actual Windows
measurements. Case totals, parallel file time, suite time and overall CI time
have different boundaries; reducing these Bot cases does not establish an equal
improvement in the repository's browser-dominated CI completion time.
