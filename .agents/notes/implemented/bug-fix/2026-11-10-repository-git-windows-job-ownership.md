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

Windows repository Git uses a native platform owned-command backend. Synchronous
CreateProcessW assigns a private, noninheritable, anonymous Job through a Job-list
attribute and creates the target suspended. Its restricted handle list contains
only NUL stdin and the two output writers. The parent records the original
process/thread capabilities before decoding or cleanup can fail, verifies the
original identity and Job membership, and checks the existing deadline before
resuming the target. An observation duplicate belongs to the Job scope; the
original process capability remains with the backend for exit observation. The
target is never reacquired through a PID.

Public Node named-pipe servers read from native client writers. A private nonce
pairs each accepted socket; the client also checks the server PID. Listening
stops before target creation, while connected sockets retain their actual EOF
and backpressure. Handshake bytes do not enter Git output. Inheritable stdio
copies exist only during the synchronous creation interval and are closed in the
parent immediately afterward. Node's argv, executable search, environment and
native error rules remain the compatibility boundary. Node permission flags
propagate before environment-key deduplication. A synchronous builtin check with
a trusted, harmless Node command and invalid stdin descriptor observes whether
Node actually reads the parent permission arguments during normalization. The
original argument array and descriptor are restored as stdio parsing begins,
before the binding can publish reentrant permission diagnostics; a finally path
also restores them after an earlier error. Captured normalization inputs determine
propagation without relying on a cloned environment's mutation or mutable flags
to infer the active mode. The same builtin permission check runs before native
creation; only its pre-creation EBADF result with no child PID admits the target.
Enforced denial preserves the original Node error, audit-only policy retains its
warning semantics, and an unexpected result refuses native launch. No observer
child interprets the copied options. Node's
[normalization and stdio ordering](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/lib/child_process.js#L885-L933)
precedes its
[synchronous permission diagnostics](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/src/permission/permission.cc#L248-L278).

The backend does not assign Git to the CLI's implicit libuv child Job. Actual
ambient Job restrictions still apply. Review keeps its Node guardian and strict
stop/retain policy. The
[libuv creation path](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/deps/uv/src/win/process.c#L1052-L1110)
explains why an added strict Job below a Node guardian's ancestor could otherwise
change background lifetime after the CLI exits.

An abnormal Git stop first installs and reads back an active-process limit of
zero while preserving other Job limits. Chromium uses the same
[post-creation restriction](https://chromium.googlesource.com/chromium/src/+/fc70fd9dbcc4b7a8973ad8a44a2d0964e4f5b15c/sandbox/win/src/sandbox_policy_base.cc#643)
and [read-modify-write implementation](https://chromium.googlesource.com/chromium/src/+/fc70fd9dbcc4b7a8973ad8a44a2d0964e4f5b15c/sandbox/win/src/job.cc#94).
The stop then terminates the held Job, confirms captured original objects,
releases completed observation references, checks sealed membership accounting
and joins the original target and actual pipes. A denied association can remain
counted while its process references are held; observers must not create their
own zero-count deadlock. An empty count cannot override a pending captured
object, and the proof does not claim per-object observation of every historical
member.

Unforced completion, including an ordinary nonzero exit, uses release rather
than stop. After the real target result and natural EOF, it clears the inner
kill-on-close flag and closes its owner without sealing or terminating normal
background members. The last Operation check, synchronous disarm/readback and
handoff commit form one interval without await. Once disarm is confirmed, a
close error reports release uncertainty and cannot route back into stop. An
unconfirmed disarm keeps its errors and permits one bounded restoration attempt
before failure cleanup.

Failed Git stop uses terminal best-effort cleanup within the existing budgets.
It preserves the original error and uncertainty, attempts the remaining Job
close without clearing kill-on-close, joins observable resources, and releases
its observation handles. Assisted pipe closure is recorded as such; an errored
public output is drained through its real socket rather than used to invent
EOF. Actual transport failures remain in a separate cleanup journal across
STOP; public capture failure alone does not establish a transport failure.
Creation-finalization failures enter that journal before fallible process
observation. Repository error classification retains these original objects
before operation cancellation or expiry selects the primary cause. Later cleanup
success does not erase an earlier failure. No hidden owner
is attached to an exception for a nonexistent future recovery consumer. Review's
[existing ownership contract](2026-11-09-windows-review-job-ownership.md) remains
separate.

## Alternatives

**Normalize taskkill status or accept root/pipe closure.** The same observable
result can coexist with a surviving detached descendant. Neither supplies
ownership or a termination proof.

**Use a finite process census as the termination boundary.** Original handles
avoid PID reuse, but a census alone misses later children and descendants behind
departed parents. Pre-execution Job membership and sealed admission supply the
missing structure; processes are never terminated by a reconstructed PID.

**Use one Node guardian per Git command.** The gated helper establishes ownership
and remains appropriate for review's command resolver. It adds a cold interpreter
and IPC round trip to every short Git query. Native qualification did not meet
the unchanged Windows suite budget, and a linked-worktree/submodule binding
performs fourteen such queries. The native backend removes that structural cost
without widening the command or test limits; timing results remain source-bound
validation evidence rather than a claimed speedup.

**Stop the Job after every Git result.** This would terminate legitimate
background work. Git's
[Windows spawn path](https://github.com/git-for-windows/git/blob/581291682ad5a238c08c93d1f5bd4518382a3230/compat/mingw.c#L2227-L2390)
uses console detachment without requesting Job breakaway. Natural completion
therefore needs release; it is also checked after the owning CLI exits.

**Retain a cleanup capability in the error.** Repository callers have no consumer
or bounded lifecycle for it. Terminal best-effort cleanup keeps failure visible
without adding a recovery subsystem or intentionally retaining handles forever.

## Consequences

The existing Koffi dependency supplies native creation and Job operations; no
PowerShell probe, compiler, extra runtime dependency or per-command interpreter
is required. POSIX process-group behavior, the 30-second default command limit,
the 1,500 ms real fetch fixture and the one-second native/one-second pipe cleanup
allowances remain. Already-started native calls are joined, so those allowances
do not promise preemptible wall-clock completion. A target created after the
original admission deadline remains suspended and is cleaned up.

The guarantee covers ordinary inherited Job members, including detached
children across parent exit. It is not a sandbox or transparent support for
explicit breakaway, external brokers or privileged escape. Inner release does
not remove an existing outer Job's policy.

Portable controls retain real root closure, live descendant heartbeats, native
error identity, cause and bounded cancellation observations. Copilot phase
observers use the already-persisted phase identity rather than helper argv, while
retaining their original failure injections and assertions. The real fetch
fixture requires its uploadpack execution marker. Native controls own original
process/thread lifetime, ABI and Node-data parity, pipe tail/backpressure,
surviving-member detection, seal, release and real termination refusal. A fixture
retaining a full-access Job handle cannot prove last-owner kill-on-close. A
successful Job termination request is joined before fixture-only per-object
fallback; asynchronous exit is not treated as a second termination error.

Normal release is compared with direct Git in separate short-lived CLI owners:
the background leaf must advance from a fresh heartbeat baseline after its CLI
has exited. Suspended owner-loss controls keep the ambient Job open and require
no payload marker before resume. Native results belong with the delivery
artifacts; portable passes and later main passes cannot replace them.
