# Agent Note: Frozen Herdr tool launch ownership

Status: implemented

## Problem

Herdr starts agents by kind through an interactive shell. Selecting an executable
for a version probe alone does not establish which installation that shell runs.
The Worker must preserve native detection, Session identity, terminal behavior and
the original process tree while using a frozen tool selection. Replacing a shared
daemon can also abandon live agents or uncertain startup and shutdown work.

## Decision

Each new execution freezes both Agent and Herdr recipes. A private, owner-bound
manifest maps the existing bare-kind interface to a fixed Node helper, which
starts the verified command with structured arguments and records intent and
receipt. The logical Herdr argv check remains unchanged. The mapping is limited
to the controlled parent shell; native PATH and internal CLI aliases retain their
original meaning. The [tool launch design](../../../../docs/design/herdr-tool-launch.md)
owns the protocol, storage and platform details.

A durable reservation precedes each native start RPC. Only the original caller's
explicit rejection can advance its initialization retry; unknown results retain
the reservation across calls and restarts. Helper intent and receipt also block
replay when they predate that reservation format. Cleanup cannot retire a launch
whose declared helper or native process lacks its original birth proof, even if
the recorded shell has already exited.

POSIX uses non-exported functions in the existing managed Bash without replacing
its process. Windows creates a system PowerShell 5 root pane through structured
layout argv, then uses owned ExternalScript files and a JSON/base64 argument
channel. Node, helper and native processes must remain attributable to the
original shell. Shutdown keeps responsibility for native descendants after their
helper exits.

Windows metadata inspection uses the repository's native process inspection
pattern. One held process handle supplies the root executable path and creation
time, with liveness checked before and after the observation. The readiness token
preserves the full 100ns FILETIME precision when converting to .NET ticks.
Toolhelp32 supplies candidate parent links; the original process proof and birth
chain still establish ownership. Deadlines are checked around native calls, and a
call already in progress is joined before late results are rejected and handles
are closed. Inspection changes neither the native environment nor daemon startup.

The official hook runtime probe still executes bare `powershell` in the original
native environment and working directory. Its Windows child is non-detached so
the version output is preserved; the existing runner retains its deadline and
process-tree/stream cleanup. Native metadata inspection cannot establish whether
the hook's own PATH command is available.

Windows descendant enrollment requires the original parent instance and a
strictly later child birth, including PIDs supplied directly by callers. The
[Windows process model](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process#properties)
can retain a dead parent's PID after an unrelated new process reuses it. Parent
PID equality alone therefore cannot authorize enrollment or termination. Equal
recorded birth times retain unknown ownership because their precision cannot
establish ordering. Explicit mapping cleanup and recovery check the existing
journal chains before terminating Jobs or processes; invalid records remain
intact instead of being recaptured or pruned.

The Windows helper retains a named kill-on-close Job handle through its OS
process lifetime. Worker mappings retain a second original Job handle and the
original helper process handle after verifying the owned boundary and membership.
Because that second handle suppresses last-close termination, a lightweight observer
is installed before initial member enumeration and terminates remaining members
when the original helper is signaled, even if that enumeration fails. Retirement
still requires empty Job membership, signaled observed process handles and the
original journal's stop proof before durable publication and handle release.
The helper's natural exit retains the native exit code; explicit JavaScript handle
closure must not terminate the helper before its outcome is returned.
Kill-on-close and the original-handle observer enforce the automatic lifetime
policy established at launch, independently of later journal enrollment. They
publish no retirement and grant no explicit cleanup or recovery authority when
the required journal is missing.

An observation fault closes input admission while preserving bounded cleanup
through the original handles. A member can bypass enrollment through an exited
parent only after its original Job membership and held-handle exit are confirmed,
with PID reuse excluded. Once retirement is durable, cleanup retries only retained
handle releases; it neither reopens the Job nor queries historical PIDs. Successfully
closed handles are removed individually so a later release failure cannot cause
them to be closed again.

This Herdr-specific lifetime is separate from ordinary Controller jobs.
[Temporary object references](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/nf-wdm-zwmaketemporaryobject)
can retain the kernel object without retaining its name after the last handle
closes. A missing name, even with a kill-on-close marker, does not prove that
[asynchronous process termination](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)
finished. Lost handles and missing or
contradictory boundary records therefore retain unknown cleanup responsibility.

Before first input, launch, receipt, kind, readiness, binding and the complete
original process chain must agree. Official Codex and Copilot integration can
report a new Session only after the first input triggers SessionStart. A durable
single-submission fence therefore precedes that input; successful startup also
requires the subsequent official same-pane Session report and original-process
verification. Unknown input or missing Session evidence never permits replay or
a replacement conversation.

macOS retains per-run daemons. Linux and Windows retain shared daemons with a
durable switch journal and serialized admission. A new target waits for all old
responsibilities and both endpoints to close. Original-claim recovery may recreate
only its original frozen daemon after every old process tree is confirmed stopped.
Attach uses the original Herdr client recipe. Legacy endpoints remain usable for
existing operations, while missing historical recipes cannot authorize new spawn.

This extends the [frozen runtime decision](2026-11-12-worker-frozen-tool-runtime.md),
whose initial delivery kept Herdr automatic until its distinct shell and instance
ownership could be established. It consumes the same
[resolver](2026-11-11-worker-tool-path-resolution.md) without broadening loader
recognition or changing upstream Herdr.

Independent Windows CIM and console acceptance queries own their execution
environment. They inherit explicit system variables, use private user and
temporary directories under the test root, and load system PowerShell 5 modules.
Queries use non-detached children without `windowsHide`, which otherwise selects
[`CREATE_NO_WINDOW` with redirected streams](https://github.com/nodejs/node/blob/e63cab040c09d43ceef8cb35508c40044614e906/deps/uv/src/win/process.c#L1033-L1051).
This matches the successful harness inventory's console creation flag without
changing stdin handling. Fixed checkpoints locate stalled query stages; they
neither establish the cause of a timeout nor replace OS results and close proof.
Query semantics, original target PIDs, deadline and close requirements remain
unchanged. ExternalScript discovery and official hook checks retain the native
environment; an observer cannot repair or replace that environment.

## Alternatives

**Add an executable RPC or modify Herdr.** This would require an upstream protocol
and release change. The existing kind and layout interfaces provide the required
launch mechanism while preserving the original argv checks.

**Replace the audit shell or start a nested persistent PowerShell.** Replacing
the shell loses its birth identity; a nested shell prevents Herdr from seeing an
idle root suitable for agent startup. Root preparation keeps the expected topology.

**Require a new Session ID before any input.** Official integration for the
verified Codex and Copilot releases does not supply that ID at the initial idle
prompt. Waiting there cannot reach the first input. The ordered proof and durable
input fence retain identity protection without manufacturing an integration event.

**Switch all platforms by draining one shared daemon.** macOS already isolates
each run and can start a new execution with a different tool while old executions
remain healthy. Shared drain is needed only for the shared-instance topology.

**Refresh recipes or helper paths during recovery.** This can use a different
installation under the same claim and native Session. Recovery retains original
metadata and fails if a required original dependency cannot be verified.

**Trust parent PID links and verify each descendant only at shutdown.** A birth
proof can faithfully identify the wrong descendant. Windows retains stale parent
IDs, so shutdown identity checks alone cannot repair mistaken enrollment.

**Query root identity and process inventory through private PowerShell children.**
Non-detached execution repaired the observed successful exits with empty output,
but real Windows readiness still exhausted its budget in process metadata
queries. Simple marker commands completed in the same private environment while
cmdlet-based queries timed out; the cause within that environment was not
established. Native inspection removes that additional shell and module-loading
dependency without extending the deadline or weakening identity checks. The
controlled root shell itself remains PowerShell 5 and retains its real-platform
acceptance requirement.

**Close the Job handle after assignment or treat a missing name as empty.** The
name can disappear while member references retain the object. Kill-on-close also
initiates termination without proving every process has finished. Original handle
observation is required to confirm complete shutdown.

**Retain only a helper-owned Job handle.** This preserves the name during normal
execution, but a helper crash loses the handle needed to observe detached members.
The Worker retains a second handle and explicitly observes and terminates the
remaining members; losing both holders still leaves cleanup unknown.

**Run independent acceptance queries in the native tool's minimal environment.**
CIM queries timed out there while the same execution's harness-environment CIM
inventory succeeded. The specific environment dependency was not established.
The observer owns its own isolated Windows environment so its query dependencies
do not alter the program under test or inherit Provider credentials.

## Consequences

Tool observations can distinguish the latest target from multiple retained running
selections. Unknown startup, stopping, input and process facts remain explicit
responsibilities, which may delay new shared-instance admission. Retaining those
records costs disk space and requires conservative cleanup across generations.

Private mapping files and process proofs add a separate evidence path alongside
macOS lifecycle records; neither substitutes for the other's input or stop rules.
Three operating-system CI jobs exercise official binaries, root shells, terminal
ownership, official Session reporting and independent cleanup. These isolated
native checks do not establish authenticated Provider or complete Worker behavior.
PowerShell 7 is not part of the supported mapping path.
