# Agent Note: Windows Repository Git Ownership

Status: implemented

## Problem

A Windows tree-termination result cannot establish whether every ordinary Git
process has stopped. A root can exit while a detached child keeps running, and a
child can disappear while a termination utility walks the tree. Root closure,
closed output streams and a finite ancestry snapshot cannot distinguish these
outcomes. The original Git deadline remains meaningful, but returning it as the
only error requires confirmed cleanup.

The
[previous runner](https://github.com/codetreker/daynight/blob/128cb89742a9dcd1e2003081ba284ee852070794/packages/daynight/src/repository/git.ts#L116-L140)
kept uncertain termination in an AggregateError with the original operation
failure as its cause. A mixed taskkill result does not prove that the historical
failure was a false positive; later passing commits do not recover those process
identities.

## Decision

This note preserves the native repository Git backend adopted in
[PR #1027](https://github.com/codetreker/daynight/pull/1027), including its
rationale, alternatives and qualification boundaries. The
[reversal decision](../simplification/2026-11-11-revert-native-windows-git.md)
removes that backend and owns the current repository Git policy. The adoption
below is historical; review's independent Job ownership remains active.

Windows repository Git used a native platform owned-command backend. Synchronous
CreateProcessW assigned a private, noninheritable, anonymous Job through a Job-list
attribute and created the target suspended. Its restricted handle list contained
only NUL stdin and the two output writers. The parent recorded the original
process/thread capabilities before decoding or cleanup could fail, verified the
original identity and Job membership, and checked the existing deadline before
resuming the target. An observation duplicate belonged to the Job scope; the
original process capability remained with the backend for exit observation. The
target was never reacquired through a PID.

Public Node named-pipe servers read from native client writers. A private nonce
paired each accepted socket; the client also checked the server PID. Listening
stopped before target creation, while connected sockets retained their actual EOF
and backpressure. Handshake bytes did not enter Git output. Inheritable stdio
copies existed only during the synchronous creation interval and were closed in
the parent immediately afterward. Node's argv, executable search, environment and
native error rules remained the compatibility boundary. Node permission
propagation was delegated to the running builtin normalizer before
environment-key deduplication. During a synchronous invalid-stdin-descriptor
check, narrow string-like argument records returned the original primitive for
prefix checks and captured only the coercions in actual append branches. This
preserved each runtime's flag selection, conditional allowances and target
opt-out rules without maintaining a version-specific mirror. Original target
arguments followed the harmless probe script's `--`; original `NODE_OPTIONS`
participated in normalization but was never executed by an observer child.

The original argument array and descriptor were restored as stdio parsing began,
before the binding could publish reentrant permission diagnostics; a finally path
also restored them after an earlier error. The same builtin permission check
ran again before native creation. Only a pre-creation EBADF result with no child
PID admitted the target. Enforced denial preserved the original Node error,
audit-only policy kept its warning semantics, and an unexpected result refused
native launch. Node's
[normalization and stdio ordering](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/lib/child_process.js#L885-L933)
precedes its
[synchronous permission diagnostics](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/src/permission/permission.cc#L248-L278).

The backend did not assign Git to the CLI's implicit libuv child Job. Actual
ambient Job restrictions still applied. Review kept its Node guardian and strict
stop/retain policy. The
[libuv creation path](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/deps/uv/src/win/process.c#L1052-L1110)
explains why an added strict Job below a Node guardian's ancestor could otherwise
change background lifetime after the CLI exits.

An abnormal Git stop first installed and read back an active-process limit of
zero while preserving other Job limits. Chromium uses the same
[post-creation restriction](https://chromium.googlesource.com/chromium/src/+/fc70fd9dbcc4b7a8973ad8a44a2d0964e4f5b15c/sandbox/win/src/sandbox_policy_base.cc#643)
and [read-modify-write implementation](https://chromium.googlesource.com/chromium/src/+/fc70fd9dbcc4b7a8973ad8a44a2d0964e4f5b15c/sandbox/win/src/job.cc#94).
The stop then terminated the held Job, confirmed captured original objects,
released completed observation references, checked sealed membership accounting
and joined the original target and actual pipes. A denied association can remain
counted while its process references are held; observers must not create their
own zero-count deadlock. An empty count cannot override a pending captured
object, and the proof did not claim per-object observation of every historical
member.

Unforced completion, including an ordinary nonzero exit, used release rather
than stop. After the real target result and natural EOF, it cleared the inner
kill-on-close flag and closed its owner without sealing or terminating normal
background members. The last Operation check, synchronous disarm/readback and
handoff commit formed one interval without await. Once disarm was confirmed, a
close error reported release uncertainty and could not route back into stop. An
unconfirmed disarm kept its errors and permitted one bounded restoration attempt
before failure cleanup.

Failed Git stop used terminal best-effort cleanup within the existing budgets.
It preserved the original error and uncertainty, attempted the remaining Job
close without clearing kill-on-close, joined observable resources, and released
its observation handles. Assisted pipe closure was recorded as such. Abnormal
stop resumed intact public outputs so unread backpressure could not prevent pipe
completion. A destroyed
public output was instead unpiped and drained through its real socket. Both paths
still required actual socket EOF; neither invented it. Actual transport failures
remained in a separate cleanup journal across STOP; public capture failure alone does not establish a transport failure.
Creation-finalization failures entered that journal before fallible process
observation. Repository error classification retained these original objects
before operation cancellation or expiry selected the primary cause. Later cleanup
success did not erase an earlier failure. No hidden owner
was attached to an exception for a nonexistent future recovery consumer. Review's
[existing ownership contract](2026-11-09-windows-review-job-ownership.md) remained
separate.

## Alternatives

**Normalize taskkill status or accept root/pipe closure.** The same observable
result can coexist with a surviving detached descendant. Neither supplies
ownership or a termination proof.

**Use a finite process census as the termination boundary.** Original handles
avoid PID reuse, but a census alone misses later children and descendants behind
departed parents. Pre-execution Job membership and sealed admission supplied the
missing structure; processes were never terminated by a reconstructed PID.

**Use one Node guardian per Git command.** The gated helper establishes ownership
and remains appropriate for review's command resolver. It adds a cold interpreter
and IPC round trip to every short Git query. Native qualification did not meet
the unchanged Windows suite budget, and a linked-worktree/submodule binding
performed fourteen such queries. The native backend removed that structural cost
without widening the command or test limits; timing results remain source-bound
validation evidence rather than a claimed speedup.

**Stop the Job after every Git result.** This would terminate legitimate
background work. Git's
[Windows spawn path](https://github.com/git-for-windows/git/blob/581291682ad5a238c08c93d1f5bd4518382a3230/compat/mingw.c#L2227-L2390)
uses console detachment without requesting Job breakaway. Natural completion
therefore needs release; it was also checked after the owning CLI exits.

**Retain a cleanup capability in the error.** Repository callers have no consumer
or bounded lifecycle for it. Terminal best-effort cleanup kept failure visible
without adding a recovery subsystem or intentionally retaining handles forever.

## Consequences

The existing Koffi dependency supplied native creation and Job operations; no
PowerShell probe, compiler, extra runtime dependency or per-command interpreter
was required. POSIX process-group behavior, the 30-second default command limit,
the 1,500 ms real fetch fixture and the one-second native/one-second pipe cleanup
allowances remained. Already-started native calls were joined, so those allowances
did not promise preemptible wall-clock completion. A target created after the
original admission deadline remained suspended and was cleaned up.

The adopted guarantee covered ordinary inherited Job members, including detached
children across parent exit. It was not a sandbox or transparent support for
explicit breakaway, external brokers or privileged escape. Inner release did
not remove an existing outer Job's policy.

Portable controls retained real root closure, live descendant heartbeats, native
error identity, cause and bounded cancellation observations. Copilot phase
observers used the already-persisted phase identity rather than helper argv, while
retaining their original failure injections and assertions. The real fetch
fixture required its uploadpack execution marker. Native controls covered original
process/thread lifetime, ABI and Node-data parity, pipe tail/backpressure,
surviving-member detection, seal, release and real termination refusal. A fixture
retaining a full-access Job handle cannot prove last-owner kill-on-close. A
successful Job termination request was joined before fixture-only per-object
fallback; asynchronous exit was not treated as a second termination error.

Native Git and platform fixture heartbeats appended one byte per beat and observed
file size from a fresh baseline. Repeated atomic replacement would require
[delete sharing](https://github.com/MicrosoftDocs/sdk-api/blob/656e9656bfaef34dd29cd7ee9e1146aec17e924c/sdk-api-src/content/fileapi/nf-fileapi-createfilew.md#L153-L166)
from open readers; an observation channel must not depend on replacing its hot
file. Identity and error receipts still published atomically once. Append/stat
errors remained failures, and held process identity, liveness, membership and
strict progress checks remained independent requirements. A controlled read handle
that permits writing but denies deletion qualified this protocol; it does not
identify the holder behind a historical CI error. Legacy review heartbeats kept
their separate format.

Normal release was compared with direct Git in separate short-lived CLI owners:
the background leaf had to advance from a fresh heartbeat baseline after its CLI
had exited. Suspended owner-loss controls kept the ambient Job open and required
no payload marker before resume. Native results belonged with the delivery
artifacts; portable passes and later main passes could not replace them.
