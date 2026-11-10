# Agent Note: Windows Repository Git Ownership

Status: implemented

## Problem

A Windows tree-termination result cannot establish whether every ordinary Git
descendant has stopped. A root can exit while a detached child keeps running,
and a child can disappear while a termination utility is walking the tree.
Root closure, closed output streams and a finite ancestry snapshot cannot
distinguish those outcomes. The original Git deadline remains meaningful, but
returning it as the only error requires a confirmed cleanup boundary.

The
[previous runner](https://github.com/codetreker/daynight/blob/128cb89742a9dcd1e2003081ba284ee852070794/packages/daynight/src/repository/git.ts#L116-L140)
preserved uncertain termination as an AggregateError with the original operation
failure as its cause. A mixed taskkill result does not establish that the
historical failure was a false positive; later passing commits do not supply
the missing process identities.

## Decision

Windows repository Git uses the shared platform owned-command mechanism. A
trusted one-shot Node guardian joins a private, noninheritable, anonymous Job
before it receives permission to start Git. Its bootstrap does not inherit Node
preloads or parent execArgv; the original Git environment travels in the admitted
target payload. Git retains Node's command resolver, while review retains its
cross-spawn adapter and its strict stop/retain policy.

Only the Git guardian uses Node's detached launch. Libuv otherwise assigns the
helper to the CLI's implicit kill-on-close Job; a strict inner Job could retain
that ancestor and kill normal background work when the CLI exits. The
[detached branch](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/deps/uv/src/win/process.c#L1082-L1102)
skips that assignment without requesting native Job breakaway. Actual ambient
Job restrictions still apply. The guardian keeps its pipes, IPC and process
references, and its trusted bootstrap exits on IPC disconnect before admission.
This does not promise an OS-hard kill of a hung pre-entry helper before its
private Job exists. Review and the actual Git spawn flags keep their existing
policies.

The guardian's structured target receipt and the real pipes remain separate.
Its exit code never substitutes for Git's result. The command deadline includes
guardian startup and admission, and remains active until the target result and
natural stream closure permit normal completion. Missing results, protocol
failure and forced stream destruction cannot establish successful completion.

An abnormal Git stop first installs and reads back an active-process limit of
zero while preserving the other Job limits. This closes new ordinary process
admission before inventory and termination. Chromium uses the same
[post-creation restriction](https://chromium.googlesource.com/chromium/src/+/fc70fd9dbcc4b7a8973ad8a44a2d0964e4f5b15c/sandbox/win/src/sandbox_policy_base.cc#643)
and [read-modify-write implementation](https://chromium.googlesource.com/chromium/src/+/fc70fd9dbcc4b7a8973ad8a44a2d0964e4f5b15c/sandbox/win/src/job.cc#94).
The stop then terminates the held Job, confirms captured original process
objects, releases completed observation references, checks sealed membership
accounting and joins the guardian, IPC and actual pipes. A denied association
can remain counted while its process references are held; observers must not
create their own zero-count deadlock. An empty count cannot override an observed
pending object, and the proof does not claim per-object observation of every
historical member.

Unforced completion, including an ordinary nonzero Git exit, uses release rather
than stop. After the real receipt and EOF, it clears the inner kill-on-close
flag and closes its owner without sealing or terminating background members.
The last Operation check, synchronous disarm/readback and handoff commit form
one interval without await. Once disarm is confirmed, a close error reports
release uncertainty and cannot route back into stop. An unconfirmed disarm
retains its errors and permits one bounded restoration attempt before failure
cleanup; no state is inferred from a failed native call.

Failed Git stop uses terminal best-effort cleanup within the existing budgets.
It preserves the original error and uncertainty, attempts the remaining Job
close without clearing kill-on-close, joins what can be observed, and releases
its observation handles. Assisted pipe or IPC closure is recorded as such.
Later cleanup success does not erase the earlier error. No hidden owner is
attached to an exception for a nonexistent future recovery consumer. Review's
existing retention policy remains distinct, as described by its
[ownership decision](2026-11-09-windows-review-job-ownership.md).

## Alternatives

**Normalize taskkill status or accept root/pipe closure.** The same observable
result can coexist with a surviving detached descendant. Neither supplies
ownership or a termination proof.

**Retain a finite process census as the termination boundary.** Original handles
avoid PID reuse, but a census alone misses later children and descendants behind
departed parents. Pre-execution Job membership and sealed admission provide the
missing structure; processes are never terminated by a reconstructed PID.

**Launch directly with native Job-list or suspended creation.** This avoids a
guardian process but requires a complete native argv, environment, stdio, exit
and cancellation adapter. Public Node pipe integration also needs tail-byte and
EOF qualification. This remains the alternative if measured guardian startup
cannot satisfy the unchanged command budgets, rather than a reason to increase
those budgets.

**Stop the Job after every Git result.** This would terminate legitimate
background work. Git's
[Windows spawn path](https://github.com/git-for-windows/git/blob/581291682ad5a238c08c93d1f5bd4518382a3230/compat/mingw.c#L2227-L2390)
uses console detachment without requesting Job breakaway; console detachment
does not imply ownership escape. Natural completion therefore needs release.

**Retain a cleanup capability in the error.** Repository callers have no consumer
or bounded lifecycle for such a capability. Terminal best-effort cleanup keeps
failure visible without introducing a recovery subsystem or intentionally
retaining handles indefinitely.

## Consequences

Each Windows Git command adds one Node guardian and Job setup. Native bindings
are shared through the existing Koffi dependency; no PowerShell probe or new
runtime dependency is required. Additional startup latency remains a native
qualification requirement; process count alone supplies no timing result. POSIX process-group
behavior, the 30-second default command limit, the 1,500 ms real fetch fixture
and the one-second native/one-second pipe cleanup allowances remain unchanged.
Already-started native calls are joined, so these allowances do not promise
preemptible wall-clock completion.

The ownership guarantee covers ordinary inherited Job members, including
detached descendants across parent exit. It is not a sandbox or transparent
support for explicit breakaway, external brokers or privileged escape. Inner
release does not remove an existing outer Job's policy.

Portable controls retain real root closure, live descendant heartbeats, original
native error identity, cause and bounded cancellation observations. The real
fetch fixture also requires its uploadpack execution marker, so startup alone
cannot satisfy a timeout assertion. Windows native controls own Job admission,
surviving-member detection, seal, release and real termination refusal. A fixture
that retains an additional full-access Job handle cannot serve as proof of
last-owner kill-on-close. Source-bound native results belong with the delivery
artifacts; a portable pass or later main pass does not replace them.
Normal release is also compared with direct Git in separate short-lived CLI
owners: the background leaf must advance from a fresh heartbeat baseline after
the owning CLI has exited. Pre-admission owner-loss controls keep the ambient
Job open and require the detached trusted helper to exit without a target marker.
