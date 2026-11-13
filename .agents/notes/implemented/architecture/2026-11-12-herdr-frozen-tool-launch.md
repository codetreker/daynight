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

A durable reservation precedes each native start RPC. The original caller can
record a definite rejection or, if admission closes before dispatch, a known
unsubmitted attempt. A later call can advance that same request only after
matching its owner, nonce, selection, binding and logical arguments and confirming
that no helper intent or receipt exists. Each advance first publishes a create-only
attempt fence, preventing concurrent admission and replay after interrupted
publication. Reserved or unknown results retain the
fence across calls and restarts. Admission is checked again after asynchronous
preparation, immediately before synchronous lifecycle submission and RPC dispatch.
This preserves configuration waits without interpreting an uncertain launch as
unsubmitted. Helper intent and receipt also block replay when they predate that
reservation format. Cleanup cannot retire a launch
whose declared helper or native process lacks its original birth proof, even if
the recorded shell has already exited.

POSIX uses non-exported functions in the existing managed Bash without replacing
its process. Windows creates a system PowerShell 5 root pane through structured
layout argv, then uses owned ExternalScript files and a JSON/base64 argument
channel. Node, helper and native processes must remain attributable to the
original shell. Shutdown keeps responsibility for native descendants after their
helper exits.

Missing mapping indexes for frozen executions reject recovery instead of
selecting legacy behavior. Owner-only stop reads the original persistent
configuration to recover the mapping, even after caches are lost and before an
empty pane reports an Agent. An omitted optional control mode retains the existing
Herdr default; an explicit Web mode still rejects the mapping. Existing mapping
evidence with missing or conflicting configuration rejects cleanup; only an execution lacking both a frozen recipe
and an unretired mapping can use legacy stop. Restored mappings must agree with any
cached nonce and selection key before process proof and retirement proceed.
Windows reopens the original validated manifest's
Node/helper paths; POSIX also checks the retained shell runtime. An installation
change cannot replace the helper in an existing generation.

POSIX cleanup treats foreground PIDs as candidates, including IDs retained after
an earlier failed stop. Only preparation can establish the first root; cleanup
requires the original journal. New descendants need a live original parent or
process-group member whose recorded identity matches before and after candidate
capture. Historical stopped PID and group numbers cannot establish ownership.
Already enrolled detached descendants retain their individual original proofs.
An unexplained foreground candidate cannot be enrolled or signaled and blocks
workspace closure while preserving the original cleanup responsibility.

Windows cleanup distinguishes an exit transition from completed process exit.
It retains the original process handle while inspecting identity, terminates only
a running original instance, and waits for an exiting instance to become signaled.
An absent inventory entry alone cannot discharge an original proof. Retirement
requires every retained process and Job to be stopped; mismatches, timeout and
handle-release failures keep responsibility. Input and launch verification still
require complete running identity. This follows the process API's exit-state
contract without treating a cleanup race as success.

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

Legacy Linux/Windows input runs its caller-supplied admission guard after all
asynchronous mapping and readiness verification. The verified mapping remains
local through the synchronous cancellation check and continuation dispatch.
Initial input still publishes its create-only intent after admission and before
dispatch. Reading pause and claim before mapping proof
would let a change during that proof authorize a stale continuation. A denied
guard returns skipped without a prompt or initial intent; a failed read or
cancellation remains an error. Initial assignment without a caller guard keeps
its existing policy, and macOS durable input retains the arbiter's beforeWrite
checks.

After submitted input, a direct Windows command-line proof failure with
`STATUS_PROCESS_IS_TERMINATING` permits another complete observation within the
original operation budget. The first valid official Session and receipt remain
fixed through those observations. A temporarily missing Session remains
unconfirmed without changing that identity; a different ID or receipt fails.
Every successful confirmation still requires
the original binding and complete process proofs; no process is skipped and no
journal responsibility is discarded. Other errors, including aggregated handle
release failures, stop confirmation. A terminal failure retains both the first
termination observation and the final cause. This waiting path never submits
input or starts a native process.

macOS retains per-run daemons. Linux and Windows retain shared daemons with a
durable switch journal and serialized admission. A new target waits for all old
responsibilities and both endpoints to close. Original-claim recovery may recreate
only its original frozen daemon after every old process tree is confirmed stopped.
The [claim tool reservation](2026-11-12-herdr-claim-tool-reservations.md) also
retains that selection while a claim request is outstanding and transfers it to
the actual grant atomically. Authorized pending claims can restore the daemon
without bypassing Agent capacity admission. Restoring that infrastructure does not
require completed repository-format preparation: legacy migration itself must
observe the original daemon. Automatic recovery still requires an explicitly
selected Project and fresh claim/permission checks. Explicit retry restores the
original daemon before preparing the retained repository, then validates the
original manifest/cwd before native recovery. The infrastructure API accepts only
the original owner and Agent, so it cannot invent a worktree path before migration. Explicit retry enters that execution
recovery directly when a frozen Herdr recipe and backend capability exist. Its
management configuration intentionally selects no automatic projects, so global
reconnection cannot be a prerequisite after normal shutdown. Fresh claim, Worker,
worktree, Agent, mode, permission, pause and in-progress project-stop checks remain
required; automatic reconciliation retains its project selection gates.
Herdr connection and inventory failures do not prevent an independently retained
active Web execution from being scheduled after its project and claim inventory
are covered. Its original worktree and persistent Web execution remain required,
and normal execution admission rechecks identity and authorization. The original
Herdr error still leaves global capacity unknown and blocks pending activation
and new claims. Explicit retry, cleanup and completion use the original
execution's backend rather than the current target configuration.
Attach uses the original Herdr client recipe. Legacy endpoints remain usable for
existing operations, while missing historical recipes cannot authorize new spawn.

This extends the [frozen runtime decision](2026-11-12-worker-frozen-tool-runtime.md),
whose initial delivery kept Herdr automatic until its distinct shell and instance
ownership could be established. It consumes the same
[resolver](2026-11-11-worker-tool-path-resolution.md) without broadening loader
recognition or changing upstream Herdr.

The [launcher admission policy](2026-11-12-worker-launcher-admission.md) owns the
files included in each recipe. New Codex Node recipes freeze the loader, Worker
Node and recorded files without statically selecting a native dependency. Older
recipes retain every recorded runtime, manifest and command argument. Herdr's
process chain and official Session checks prove the running native identity;
they do not establish a pre-launch fingerprint for an unrecorded dynamic native.

Independent Windows WMI and console acceptance queries own their execution
environment. They inherit explicit system variables, use private user and
temporary directories under the test root, and provide the system PowerShell 5
module path as input. PowerShell may expand that search path at startup; the
queries use direct .NET APIs without module autoloading.
Queries use non-detached children without `windowsHide`, which otherwise selects
[`CREATE_NO_WINDOW` with redirected streams](https://github.com/nodejs/node/blob/e63cab040c09d43ceef8cb35508c40044614e906/deps/uv/src/win/process.c#L1033-L1051).
This matches the successful harness inventory's console creation flag without
changing stdin handling. Fixed checkpoints locate stalled query stages; they
neither establish the cause of a timeout nor replace OS results and close proof.
Process observation directly loads .NET `System.Management` and queries
`Win32_Process` for exactly the original shell, helper and native PIDs. A fixed
field envelope preserves parent IDs, executable paths, command lines, raw DMTF
births and corresponding UTC ticks. Decoding validates complete unique rows and
the raw birth/ticks relationship before comparing with the independent inventory.
Those WMI tokens have microsecond precision and cannot replace the readiness
check's full 100ns precision. All WMI objects, enumerator, collection and searcher
must be disposed before output is published. Original target PIDs, deadline,
console APIs and close requirements remain unchanged. ExternalScript discovery
and official hook checks retain the native environment; an observer cannot repair
or replace that environment.

Console observation defines its P/Invoke type with `Reflection.Emit` and checks
the resulting metadata before calling `FreeConsole`, `AttachConsole` and
`GetConsoleProcessList`. Winapi, `SetLastError`, `PreserveSig`, BOOL returns and
the output array remain explicit. It publishes the complete bounded PID frame
only after detaching from the target console. The observer creates no compiler
child or assembly file; its dynamic assembly ends with the original PowerShell
process. The original shell, helper and native PIDs must all appear in the same
console result.

Real-platform initialization resolves Windows Git from inherited PATH with the
existing filesystem-based `which` dependency, then runs real `git init` with its
five-second execution timeout. Command failure diagnostics preserve code, killed,
signal and elapsed time. The fixture records initialization before adapter
construction and advances the stage before constructing it. Independent cleanup
accepts a no-resource initialization failure only with an explicit error and
elapsed diagnostic, absent process and endpoint/receipt evidence, zero inputs and
requests, a closed mock and no query resources. Directory and link checks remain
mandatory. Contradictory or missing initialization evidence fails cleanup; the
original initialization error still fails the platform test.

Final Windows acceptance cleanup independently rereads each original process birth
after adapter construction.
CIM CreationDate and the metadata oracle's .NET StartTime keep their respective
original token sources and precision. Missing or replaced identities can confirm
original absence only alongside complete original stop evidence; a live original,
missing original identity, failed query or incomplete output fails validation.
Results retain both identities, their source and observation errors. The observer
never signals inspected PIDs and still checks endpoints, directories and query
resource closure.

Windows cleanup policy tests execute the real checker and filesystem operations
with controlled observations at the OS query boundary. Dedicated native jobs own
the real PowerShell 5 query, same-source birth comparison and script entry point;
their success remains mandatory. POSIX entry tests and the observer's real child
timeout/close test retain their direct process coverage. One Windows mechanism
test reads a live owned process through .NET; policy cases do not repeat that
system query. Script exit-code tests control the checker result at its module
boundary without starting another OS query.

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

**Abandon Session confirmation on any concurrent process exit.** Windows can
return `STATUS_PROCESS_IS_TERMINATING` after process times and basic information
were read from the same retained handle. The observed failure did not identify
which process role was exiting, so it cannot justify skipping descendants or
loosening the shared process-proof reader. Repeating the complete observation
with fixed Session and receipt identities can establish a later consistent
result; persistent errors still end at the original deadline with the first
failure retained. Merely treating the status as stopped would lose the original
ownership and cleanup requirements.

**Switch all platforms by draining one shared daemon.** macOS already isolates
each run and can start a new execution with a different tool while old executions
remain healthy. Shared drain is needed only for the shared-instance topology.

**Broaden automatic project selection to admit explicit retry.** Explicit retry
already has an execution-level recovery path with fresh authorization checks.
Changing global selection would couple a single-claim management command to
automatic scheduling and risk advancing unrelated work. Entering the existing
path directly preserves that separation and the shared adapter's stop proof.

**Refresh recipes or helper paths during recovery.** This can use a different
installation under the same claim and native Session. Recovery retains original
metadata and fails if a required original dependency cannot be verified.

**Infer stop mapping identity from the live pane or Agent cache.** Neither exists
after a restart before native startup. Treating that absence as legacy would
close the workspace without retiring its frozen mapping, preserving stale shell
and Windows layout evidence for a later attempt. The original stored
configuration supplies the owner-bound identity independently of live detection.

**Treat an unavailable Herdr snapshot as empty to continue Web work.** Empty
resources would admit new work without accounting for retained native processes.
Scheduling only independently proven active Web executions preserves their
progress while leaving global admission and Herdr responsibility unresolved.

**Capture every reported foreground PID and check its new birth before signaling.**
Cleanup retains candidate IDs across failures. If an uncaptured child exits and
its PID is reused, the new proof consistently identifies an unrelated process.
A fresh birth token cannot establish ownership; enrollment must first connect
the candidate to a still-live original tree or group member.

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

**Keep CimCmdlets as the process oracle.** Private observer directories and an
ordinary console creation flag did not resolve its timeout. Fixed checkpoints
showed that the script entered but `Get-CimInstance` did not return before the
deadline; projection and JSON serialization had not started. Direct
`System.Management` retains an independent OS/WMI observation without that cmdlet
dependency. This does not identify the internal cause of its stall or relax the
deadline and required identity fields.

**Use PID-only liveness for final independent cleanup.** A PID can be reused after
the original process exits. Treating every non-ESRCH error as live also loses the
distinction between access failure and a successful query. The original process
identity remains the cleanup subject; a fresh independent birth comparison keeps
that distinction without trusting the fixture's exit report alone.

**Repeat native Windows queries for every cleanup policy case.** Each policy
fixture would create four processes and repeatedly launch PowerShell to establish
births and check their absence. Those repetitions add system-query dependencies
to assertions about metadata, directories and close evidence. Controlled query
results preserve those policy boundaries, while the dedicated native job verifies
the actual query and entry point. Query deadlines and unknown-result rejection
remain unchanged; reducing repetitions does not establish the cause of an
observed query timeout.

**Compile the console interop type at query time.** The `Add-Type` query reached
its entry checkpoint but did not return before the deadline. That interval
includes module discovery, compilation and type loading; the internal cause
remains unknown. Direct CodeDOM compilation would still create temporary files
and a compiler child, including with `GenerateInMemory=true`, and could repeat
the same compilation dependency. `Reflection.Emit` preserves the independent
console APIs without those resources or a cmdlet/JSON dependency. Actual PS5
execution must still establish that the emitted declarations behave correctly.

**Locate Git through a timed `where.exe` child.** The fixture only needs an
executable path and already depends on `which`. An extra lookup child adds a
process deadline before real Git runs. The observed Windows failure retained
only `Command failed: where.exe git.exe`, which cannot distinguish nonzero exit
from timeout; the historical exit status remains unknown. Filesystem resolution
removes that extra child without extending the real Git deadline.

## Consequences

Tool observations can distinguish the latest target from multiple retained running
selections. Unknown startup, stopping, input and process facts remain explicit
responsibilities, which may delay new shared-instance admission. Retaining those
records costs disk space and requires conservative cleanup across generations.
Backend fault isolation preserves existing Web progress but cannot establish
free capacity or allow new work while Herdr resource observation remains unknown.

Private mapping files and process proofs add a separate evidence path alongside
macOS lifecycle records; neither substitutes for the other's input or stop rules.
Three operating-system CI jobs exercise official binaries, root shells, terminal
ownership, official Session reporting and independent cleanup. These isolated
native checks do not establish authenticated Provider or complete Worker behavior.
PowerShell 7 is not part of the supported mapping path.
