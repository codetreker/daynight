# Agent Note: Windows Review Termination Completion

Status: implemented

## Problem

A successful `taskkill /T /F` and closure of the directly launched agent do not
establish that every targeted process has finished exiting. A descendant can
remain unsignaled after both events while its heartbeat has already stopped.
Finalizing the review at that point can release execution ownership before the
observed foreground process has exited. Windows documents external process
termination as asynchronous and requires waiting on the process handle to
confirm completion.

## Decision

The captured-process completion rule remains in effect. The
[Job ownership decision](2026-11-09-windows-review-job-ownership.md) replaces
ancestry-based termination for both product review phases. This note owns the
remaining legacy helper and the rationale for waiting on original process
objects, including its bounded ancestry diagnostics.

The legacy unowned Windows stop helper retains `taskkill /T /F` and native exit
confirmation for the process objects captured before termination. After native
library loading, it rechecks the original `ChildProcess`, opens its process
object with query and synchronization rights, and verifies that the root remains
a child of the current CLI and has not signaled exit. The held root object pins
the PID used by `taskkill`.

A Toolhelp snapshot supplies descendant candidates. Each opened candidate is
checked through the same retained handle for its PID, parent PID and creation
time. Its parent must already have a trusted retained object, and the child's
creation time cannot precede that parent's. This prevents a recycled intermediate
PID from silently reassigning an older descendant to a different process object.
A replacement child of the same retained parent can be observed as a current
member; retaining the handle fixes the identity used for the subsequent wait.

A PID that no longer exists does not require waiting. Enumeration continues
through missing intermediate nodes: an entirely disappeared branch is finished,
while a surviving descendant without a provable parent makes confirmation fail.
If descendant observation fails but the original root remains verifiably live,
the supervisor still attempts its existing tree termination and preserves the
observation failure. It does not issue `taskkill` after root identity or liveness
has become uncertain.

Live ancestry rejections share one diagnostic in that failure chain. It records
the held root identity and at most eight candidate observations, distinguishing
an unproven parent, a parent PID that differs from the snapshot, and a child
created before its held parent. Each observation contains only the snapshot
PID/parent PID, held identities and the unsignaled result; creation times remain
decimal strings without precision loss. Total and omitted candidate counts
preserve the scale of a larger rejected branch. The cap applies only to recorded
facts: inventory, failure retention and handle cleanup continue for every
candidate. Command lines, environment values and native handle addresses are
not collected.

After `taskkill`, the supervisor polls every accepted original process handle
with `WaitForSingleObject(handle, 0)` until all are signaled or the confirmation
grace expires. The existing direct-process and stream close check still follows,
including after native confirmation fails. Native state can become observable
before Node delivers its `close` event; an immediate native failure must not make
the adapter abandon that still-pending event. The supervisor marks execution
unsafe immediately, joins direct closure within its existing grace, and preserves
both the native failure and any close timeout. Direct closure cannot turn a failed
tree confirmation into successful exclusion.

Inventory errors, native wait failures, termination failures and handle-release
errors prevent successful exclusion and retain unsafe execution state. Every
acquired handle is released individually, including after partial acquisition;
one release error does not skip the remaining handles.

## Alternatives

**Wait only for the direct child and stable heartbeat.** Neither observes the
completion of the leaf's termination. A stopped writer can still have an
unsignaled process object.

**Delay for a fixed interval after taskkill.** A delay cannot establish completion
under different I/O or scheduler conditions. Waiting on the original process
objects observes the required state directly.

**Replace review startup with a gated Job Object guardian.** Assigning a job before
allowing the agent to create descendants would provide a stronger ownership
boundary, but changes the launch protocol and its lifecycle. The termination
completion defect did not require that larger change. The later
[Job ownership decision](2026-11-09-windows-review-job-ownership.md) adopts this
launch boundary to cover ordinary descendants after inventory and across parent
exit while preserving the captured-object completion rule.

**Treat a quiet snapshot as complete containment.** Snapshot enumeration cannot
prove that no process was born afterward or recover a chain through an
intermediate process that exited before enumeration. Repeated snapshots do not
remove those limitations.

**Accept exclusion after ignoring a provably older branch.** Windows can retain
an old parent PID after that PID has been reused by an unrelated process, as
explained in the [Toolhelp ancestry example](https://devblogs.microsoft.com/oldnewthing/20150403-00/?p=44313).
The older branch is not owned by the new parent. Dropping its wait requirement
does not establish that the existing `taskkill /T` will avoid targeting it.
Exclusion remains refused until the termination boundary is qualified; bounded
classification supplies evidence without weakening that refusal. Replacing
tree termination with retained-handle termination would also need to preserve
the existing handling of descendants born after inventory.

## Consequences

The stop path no longer treats a captured descendant's pending termination as
successful process exclusion. Inventory and signal confirmation have separate
bounded grace periods; the existing `taskkill` and direct stream-close limits
remain. Native calls are joined, so these checks do not claim a strict total
wall-clock bound.

The confirmation applies to the captured members. It does not strengthen
`taskkill /T` into arbitrary descendant containment or change the Windows normal
completion path. Access denial and ambiguous ancestry retain failure rather than
silently dropping a potentially live member. The legacy helper uses the existing `koffi` dependency and does not change POSIX
signaling. Product adapter startup and normal completion now follow the linked
Job ownership decision.

An old unrelated branch can still make stopping fail after every owned process
has exited. The deterministic kernel witness preserves that case alongside
valid descendants, parent-identity changes, missing intermediates, already
signaled candidates, diagnostic truncation and cleanup failures. Controlled
termination callbacks do not qualify native `taskkill` target selection, and a
passing native run without rejected candidates cannot explain a past failure.

The native contracts are documented by Microsoft's
[TerminateProcess reference](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess),
[PROCESSENTRY32W reference](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w),
and [process object and PID lifetime explanation](https://devblogs.microsoft.com/oldnewthing/20110107-00/?p=11803).
The nonexistent-PID interpretation follows
[libuv's Windows process handling](https://github.com/libuv/libuv/blob/5152db2cbfeb5582e9c27c5ea1dba2cd9e10759b/src/win/process.c).
