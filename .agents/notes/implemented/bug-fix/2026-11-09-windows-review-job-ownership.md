# Agent Note: Windows Review Job Ownership

Status: implemented

## Problem

A historical parent PID can connect an unrelated surviving process to a newly
created review root. Waiting on original process objects fixes termination
completion, but ancestry classification cannot establish that a tree-wide
termination command avoids the unrelated branch. Terminating only captured
objects would instead miss ordinary descendants born after inventory or through
an intermediate parent that has exited. Both review phases need ownership before
target code can create descendants, while retaining their actual results and
streaming behavior.

A native fixture can retain a late Job member that production never captured.
External termination is asynchronous, so that independent process object need
not be signaled at the instant the product stop returns. An immediate assertion
for every fixture handle would demand more than the captured-object completion
contract.

## Decision

Each Windows skill-discovery and review phase owns a held, noninheritable Job
handle configured for kill-on-close without breakaway permission. A trusted Node
guardian starts with `NODE_OPTIONS` removed and waits for IPC admission. The
parent retains its process object, verifies the original PID, current CLI parent
and unsignaled state, assigns that object to the Job, and checks membership and
liveness again before sending the target command. Cancellation, disconnect,
setup failure and deadline expiry close admission. Target Node preloads receive
the target environment only after assignment.

The guardian uses the existing `cross-spawn` resolver for the real command and
passes inherited pipes directly to it. Prompt backpressure and complete output
capture do not pass through an IPC buffer or capability-probe output limit. A
structured receipt preserves the target's exit code, signal and qualified
command-not-found failure independently of the guardian's exit code. The same
phase owner is used by the adapter and process supervisor, including callers
without a supplied supervisor.

Normal completion and interruption both stop the held Job, with no `taskkill`
fallback. Before termination the scope opens current Job-list candidates and
checks their membership through the same retained object. A reused PID whose
object is outside the Job is released without becoming a termination target.
Inventory errors do not skip the attempt to terminate the held Job, and remain
failures. Ordinary Job inheritance covers later children and surviving children
of vanished parents; last-owner handle closure supplies the kill-on-close path.

The [original termination-completion decision](2026-11-07-windows-review-termination-completion.md)
continues to require every actually captured process object to signal before
successful exclusion. An empty inventory or zero active count cannot override
an observed pending exit. Active count zero is an additional membership check;
it does not certify every unobserved historical object's signaled state. Each
confirmed signaled handle is released individually. Observation, wait,
termination and release errors retain unsafe execution state and the Job handle.
The original guardian exit and all direct pipe closures must also join; their
combined completion handles Node omitting `ChildProcess.close` after a parent
IPC disconnect.

The shared native boundary lives in `platform/windows-job.ts` and uses the
existing dynamically loaded `koffi` dependency. The Bot Job lease reuses that
boundary without adopting the review completion protocol. The older unowned
review helper retains its ancestry checks and diagnostics independently.

## Alternatives

**Ignore the older unrelated ancestry branch and keep tree termination.** The
classification does not establish which objects the external tree-termination
command will target. It cannot provide the required exclusion boundary.

**Terminate only the objects retained during inventory.** This avoids targeting
an unrelated object but leaves children born afterward and descendants across
missing parents outside the termination set.

**Keep qualifying the old native tree behavior before changing launch.** Native
qualification remains useful for explaining a historical incident, but does not
supply ownership for later descendants. Product termination uses the held Job;
the old incident is not claimed to be reproduced or explained.

**Reuse the Bot lease's empty-inventory completion test.** Empty membership does
not imply a previously captured process object has signaled. Review retains
per-object waits and a separate active-count check.

**Require every independent fixture handle to signal at stop return.** The
fixture intentionally creates one member after production inventory. Its
asynchronous exit is observed through the fixture's own retained handle, while
the product's captured objects still require an immediate signaled assertion.
Starting another grace period after stop would reset the budget. Additional
fixture waits use the absolute deadline established before stopping.

## Consequences

Review adds a guardian lifecycle and a native Job setup requirement on Windows.
Assignment or verification failure prevents target execution and retains any
uncertain cleanup, rather than silently switching termination strategies. The
runtime still keeps persisted-state and instance-lock recovery conservative.
POSIX process groups and signaling remain unchanged.

This is ownership of ordinary inherited Job members, not a sandbox. WMI,
external brokers and privileged processes can create work outside that Job.
The guarantee covers captured objects' completion and ordinary membership
termination, not per-object observation of every historical member.

Portable real-process tests prove streaming, admission ordering, target receipts
and IPC-loss handling with a controlled Job boundary. Deterministic native-boundary
tests prove failure retention and captured-object completion independently from
membership accounting. Windows fixtures retain representative guardian, target,
late-child, vanished-parent and bystander objects independently of production
inventory, including `.cmd` startup and last-owner loss. Explicit-stop cases
immediately require the guardian and independently held pre-stop inventory
members to be signaled at stop return. Remaining fixture-only members are
observed through their retained handles. An absolute deadline derived from the
existing five-second grace before stopping limits additional waiting. Each
observation first checks completion, so already-signaled objects pass even if
joined stop work exhausted that budget; pending objects cannot begin another
wait after expiry. This does not preempt native calls or joins, or promise a hard
total wall-clock bound. The bystander must remain alive during every observation.
All original exit and bystander heartbeat assertions finish before forced
fixture cleanup can assist termination. Preparation, cleanup and last-owner-loss
observations retain their ten-second budgets, and native cases retain their
45-second budgets. A synthetic unrelated PID-list entry tests real
`IsProcessInJob` exclusion; it does not claim native PID reuse. Actual Windows
acceptance requires executing those fixtures on the same source revision;
portable passes cannot establish native behavior.

The native ownership rules follow Microsoft's
[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject),
the asynchronous termination and process-handle waiting rules in
[TerminateProcess](https://github.com/MicrosoftDocs/sdk-api/blob/656e9656bfaef34dd29cd7ee9e1146aec17e924c/sdk-api-src/content/processthreadsapi/nf-processthreadsapi-terminateprocess.md#L89-L91),
and [gated process launch](https://devblogs.microsoft.com/oldnewthing/20181116-00/?p=100245)
references. The historical ambiguity follows the
[parent PID example](https://devblogs.microsoft.com/oldnewthing/20150403-00/?p=44313/).
