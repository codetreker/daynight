# Agent Note: Native Windows Process Proofs

Status: implemented

## Problem

Windows Controller startup needs the original process birth and full command
line before ownership can be saved and authenticated IPC can listen. A fresh
PowerShell/CIM query introduces shell and management-provider initialization
into both the parent's observation and the child's self-proof. A finite query
allowance can expire before either proof exists, leaving the submitted writer
and its resources unconfirmed.

The [startup budget decision](2026-11-05-windows-startup-process-proof-budget.md)
raised acquisition from five to fifteen seconds after matching parent and child
queries timed out. The same path recurred in the source-bound
[Windows failure](https://github.com/codetreker/daynight/actions/runs/41965894295/job/127044963808)
at `f9d0368ad19f09b52f91d0fefd721bb47a3330a5`: the parent's PID 5468 query was killed
with SIGTERM after 15114 ms, and the child's log retains the matching query
failure before Controller proof and Job publication. Parent and child ticket
paths agree. Both journals retain the original error and unknown startup state
with no Controller proof. This is the acquisition failure recurring beyond the
selected allowance, independently of the
[fixture teardown race](../testing/2026-11-05-bot-fixture-teardown.md).
The later readiness timeout and missing-proof cleanup error are consequences;
they do not establish a second writer or successful cleanup. The killed queries
do not reveal how long successful CIM acquisition would have needed.

A separate encoding weakness appeared when comparing native proof with the
original CIM query. [Hosted Windows validation](https://github.com/codetreker/daynight/actions/runs/41968955915/job/127052508668)
at `0761ad522e17dcd9ca7d64af85a36b3c7e9808f5` established matching child self-proof,
parent capture and later inspection, with an exactly matching CIM birth. Only
the oracle's command hash differed. Reconstructing the controlled argument
vector with Windows quoting reproduced the native hash; replacing its
supplementary Unicode character with two question marks reproduced the oracle
hash. Windows PowerShell's default console encoding had lost command text.
[Console.OutputEncoding](https://learn.microsoft.com/en-us/dotnet/api/system.console.outputencoding?view=netframework-4.8.1)
defaults to the system code page, so decoding its output as UTF-8 cannot recover
characters already replaced by that encoder.

## Decision

Windows process capture uses the existing Koffi dependency to query native
process information in the calling process. One `OpenProcess` handle remains
open while `GetProcessTimes` obtains birth and `NtQueryInformationProcess`
obtains basic identity and the full UTF-16 command line. Holding that handle
binds all queries to one process instance even if its numeric PID is reused.
Returned PID and parent identity, native statuses, command-line byte lengths and
pointer bounds are validated before constructing a proof. The command-line
query uses one owned allocation of the `UNICODE_STRING` header plus 65,536 bytes,
covering its `USHORT` byte-length range without trusting a returned allocation
size or dereferencing a pointer outside that buffer. The command text is hashed
in full Unicode; an executable path or text damaged by console encoding is
insufficient.

Birth retains the existing UTC representation with seven fractional digits and
CIM's microsecond precision: native FILETIME ticks are truncated to microseconds
before formatting, leaving the final fractional digit zero.
[System.Management's conversion](https://github.com/dotnet/runtime/blob/51bd84c27560d2dd3e9ae04c84c8c1fa24ea1e07/src/libraries/System.Management/src/System/Management/ManagementDateTime.cs#L170-L201)
expands CIM microseconds to DateTime ticks. The hosted comparison established
exact birth equivalence with the actual provider. `ProcessProof` retains its
PID, parent PID, nullable process group, birth, command hash and optional Job
identity fields. Native parent observation, Controller self-capture and later
inspection use the same complete command text. Historical hashes made from
lossy PowerShell output are not byte-equivalent to the full Unicode hash; they
are not accepted or recomputed through a legacy hash fallback.

Windows inspection uses a query-and-synchronization handle to separate original
birth, running identity and completed exit. The [exit completion decision](2026-11-13-windows-controller-exit-completion.md)
owns this lifecycle: a signaled original handle establishes completed exit;
changed exit status on an unsignaled handle permits waiting only. A different
birth establishes `replaced`. A running original reports `running` only when
birth, parent PID, command hash and process group agree. Same-birth conflicting
identity remains an error, preserving execution evidence and resource
responsibility. Unconfirmed native permission and unknown status failures remain
errors.
POSIX comparison behavior is unchanged.

The existing acquisition defaults remain fifteen seconds on Windows and five
seconds on POSIX, with explicit caller budgets and five-second inspection.
Windows checks its deadline after library loading, process opening, each
information call and handle closure, and waits for a call already in progress.
A JavaScript timer cannot preempt a kernel call, so this is an admission and
completion budget rather than a strict wall-clock interruption bound. Native
acquisition starts no PowerShell or CIM query. The POSIX `ps` probe retains its
timeout and locale behavior.

Acquisition failures propagate their original errors, including the native
stage and status. If handle release also fails, an `AggregateError` retains both
errors and names the acquisition error as its cause. A successful release
rethrows the original acquisition error object. A failed Controller self-proof
prevents that Controller's Job assignment, journal proof publication and
authenticated IPC readiness. A failed parent observation retains its unknown
submission while the original child can still finish its own startup. Existing
Job setup and descendant inspection remain separate operations. Unknown
submission retains the original launch identity and resource responsibility;
absence of proof or IPC never authorizes a new writer, deletion or a successful
stop result. The fixture's joined teardown remains responsible for its resources.

`NtQueryInformationProcess` is an internal Windows API whose information classes
can change. Full command-line capture uses `ProcessCommandLineInformation`
(class 60), as used for Windows 8.1 and newer by
[System Informer](https://github.com/winsiderss/systeminformer/blob/0a4975a4763ad202747397ef5daf5893849b5b00/phlib/nativeprocess.c#L1922-L1972).
Native library loading, unsupported classes, access denial and malformed results
fail visibly. They are not retried through CIM and do not produce reduced or
guessed identity. The native dependency must be reconsidered if a supported
Windows environment cannot supply the full command line.
[Microsoft's API guidance](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntqueryinformationprocess)
explains this dependency; [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)
owns the native creation-time semantics and
[CIM datetime](https://learn.microsoft.com/en-us/windows/win32/wmisdk/cim-datetime)
owns the retained precision.

## Alternatives

**Increase the query or test timeout again.** The earlier allowance already
recurred, and the failed query reveals no sufficient replacement timeout.
Extending the outer test cannot make the child publish proof or bind IPC after
its acquisition failed.

**Hash only the executable path.** `QueryFullProcessImageName` omits arguments.
Distinct command lines would compare as the same writer, weakening the existing
identity used for reconciliation and cleanup.

**Read remote PEB memory directly.** That adds remote-memory access, address
layout and cross-bitness responsibilities. A native command-line information
query supplies the complete string without adopting those additional layouts.

**Fallback to CIM after a native failure.** This restores the observed
initialization dependency and can hide access or unsupported-query failures.
Native errors must remain visible so ownership stays unconfirmed.

## Consequences

Windows capture no longer depends on a fresh shell and management provider.
It retains full identity and one process instance across the native queries,
with bounded native output and no new package dependency. The internal
command-line query remains a Windows compatibility dependency; native hosted
validation is required alongside controlled regressions.

A proof saved from lossy Unicode output remains uncertain when the same live
birth is inspected against the complete native command line. The stored hash is
not treated as another process's proof or replaced with a newly computed hash.
A named Job lookup cannot substitute for original process-instance termination;
stop confirmation therefore rejects conflicting full identity of a running
same-birth instance before considering its inventory. The linked exit completion
decision retains original process handles through termination; an already-exiting
instance is waited on through its birth-verified handle. Recovery and resource
deletion retain the original responsibility until complete stop evidence can be
established.

Focused regressions cover birth precision, complete Unicode command lines,
PID replacement, same-birth identity uncertainty before Job inspection, native
failures, malformed lengths and pointers, deadline checks and original-error
preservation. The Windows-only
[native identity regression](../../../../packages/daynight/test/commands/controller/process-proof-native-windows.test.ts)
starts one controlled child and requires its self-proof, the parent's proof and
later inspection to agree. One isolated CIM query compares birth and the full
command hash using explicit UTF-8 JSON transported inside an ASCII Base64
envelope. Canonical Base64 and strict UTF-8 decoding prevent console code-page
loss from weakening the comparison. That oracle has its own sixty-second query
allowance inside a ninety-second test; it qualifies the provider's format
without becoming a production acquisition fallback. Mismatch diagnostics record
hashes, lengths and qualification flags, never the raw command text. The child
is stopped and its close joined after either success or failure. Real
Controller/Bot integration still owns proof-before-IPC ordering, one
authenticated writer, no initialization user turn, and complete process-tree
confirmation before resource deletion.
