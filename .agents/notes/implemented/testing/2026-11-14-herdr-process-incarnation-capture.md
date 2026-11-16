# Agent Note: Herdr Process Incarnation Capture

Status: implemented

## Problem

Windows retains a process's numeric parent PID after that parent exits. A later
Herdr daemon can receive the same PID and appear to own unrelated older children.
The real-platform fixture previously followed numeric parent links when capturing
cleanup subjects, so those unrelated processes could make correct cleanup fail.
Comparing birth tokens only after shutdown cannot repair an incorrect owned set.

The [Win32_Process documentation](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process)
explicitly describes parent PID reuse and checking CreationDate to detect a
purported parent created after its child. A single run can also contain multiple
genuine owned incarnations of one PID: an early daemon child can exit before a
later child receives its PID. Rejecting that history makes a valid run fail.

## Decision

The real-platform fixture retains the original daemon identity and a history of
owned PID/birth identities. Every traversed ancestor must match a retained birth
in the current inventory. A child's birth must be no earlier than its current
parent's birth, compared as integers without floating-point rounding. Equal
births are permitted because CIM observations have microsecond precision and
Linux start tokens have clock-tick precision.

Later captures retain all original cleanup subjects. A new incarnation is owned
only when its own current parent chain reaches a verified live original
ancestor; a reused numeric PID cannot seed ownership by itself. Different births
of the same PID remain separate cleanup subjects. Windows rejects changed parent
evidence for the same birth identity; Linux permits legitimate reparenting.
Missing required identities, malformed tokens and contradictory evidence remain
errors. Capture commits its history only after validation succeeds.

The independent checker requires unique PID/birth identities and complete
post-stop evidence for every captured incarnation. It queries each current
PID/source once, then compares that result separately with every retained birth.
Any matching live original or unknown observation fails cleanup. A replaced old
incarnation cannot hide a still-live newer owned incarnation.

The [partial workspace decision](2026-11-13-herdr-partial-workspace-evidence.md)
continues to own owner-bound closure of failed preparations. Workspace, endpoint,
query closure and runtime-resource requirements remain independent gates.

## Alternatives

**Filter only against the daemon's birth.** A process can be newer than the daemon
but older than its purported intermediate parent. Every edge needs its own
birth-order check to exclude reuse below the root.

**Keep one incarnation per owned PID and reject a valid replacement.** The
[Windows platform job](https://github.com/codetreker/daynight/actions/runs/43608699992/job/132488843216)
observed an early daemon child PID reused during the same run. Refusing this
normal history rejects valid process creation; replacing the old record loses
its cleanup responsibility. Both identities must remain observable.

**Remove descendant cleanup assertions.** Checking only the four named processes
would miss additional genuine children. Capture continues to include verified
descendants and independent cleanup continues to reject live originals.

## Consequences

Cleanup ownership excludes chronologically impossible ancestor chains while
preserving genuine descendant checks across PID reuse. History costs one record
per observed incarnation, while independent OS queries stay bounded by distinct
PIDs. Inventories remain snapshots: they do not prove ownership of a process
never observed before its parent exits. Missing required evidence fails
acceptance rather than establishing cleanup.
