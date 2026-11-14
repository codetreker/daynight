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
purported parent created after its child.

## Decision

The real-platform fixture retains the original daemon identity and collects
descendants through a shared capture owner. Every traversed ancestor must still
match its retained PID and birth token. A child's birth must be no earlier than
its current parent's birth, compared as integers without floating-point rounding.
Equal births are permitted because CIM observations have microsecond precision
and Linux start tokens have clock-tick precision.

Later captures retain original cleanup subjects and admit new descendants only
through current, matching original ancestors. Reuse of a captured PID cannot
replace its identity or seed another subtree. A replacement that reconnects through a verified live original ancestor fails capture: the evidence format retains one incarnation per PID and cannot represent both as cleanup subjects. Required process identities,
malformed candidate tokens and contradictory identity evidence remain errors.
Original subjects remain available for post-stop observation after they exit.

The [partial workspace decision](2026-11-13-herdr-partial-workspace-evidence.md)
continues to own owner-bound closure of failed preparations. The independent
cleanup checker still requires complete original process identities, fresh exit
observations, closed endpoints and removed runtime resources.

## Alternatives

**Filter only against the daemon's birth.** A process can be newer than the daemon
but older than its purported intermediate parent. Every edge needs its own
birth-order check to exclude reuse below the root.

**Rebuild the owned set from current numeric roots at cleanup.** A root or known
descendant may have exited and its PID may already identify another process.
Retaining original identities prevents the replacement from becoming owned.

**Remove descendant cleanup assertions.** Checking only the four named processes
would miss additional genuine children. Capture continues to include verified
descendants and independent cleanup continues to reject live originals.

## Consequences

Cleanup ownership excludes chronologically impossible ancestor chains while
preserving genuine descendant checks. Retained identities require small
fixture-local state across capture stages. Process inventories remain snapshots;
they do not prove ownership of a process never observed before its parent exits.
Missing required evidence fails acceptance rather than establishing cleanup.
