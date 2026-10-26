# Agent Note: Foreground Review Coordination

Status: implemented

## Problem

Repository polling, Git preparation, agent execution and closure cleanup can
observe different PR states. Without shared admission and durable transitions,
they can overlap a worktree, exhaust capacity before reserving work, lose a newer
revision or repeatedly retry a failed revision. Shutdown must also stop pending
commands before releasing shared state.

## Decision

The coordinator connects the [state module](2026-10-17-durable-review-state.md),
[complete observations](2026-10-17-github-observation.md),
[owned worktrees](2026-10-17-owned-review-worktrees.md) and
[Copilot adapter](2026-10-17-copilot-session-execution.md) in the single foreground
CLI selected by the [execution decision](2026-10-16-foreground-review-cli.md).
Configured clones remain an [exclusive review environment](2026-10-17-exclusive-review-environment.md).

Each repository has an independent polling lifetime and retry deadline. A FIFO
pending map holds one latest candidate per PR while preserving its queue position.
Dispatch removes that entry, so a frequently updated PR's successor joins behind
work already waiting. Each scheduling cycle yields to the Node.js event loop:
fast polls whose next deadline is already due cannot repeatedly wake only
microtasks and starve timers or child-process I/O. A PR worktree reservation is acquired before asynchronous preparation and spans
agent execution or cleanup. Review preparation
and execution consume `maxConcurrentWorker`; cleanup uses the PR reservation
without consuming a review slot.

CI and conversation admission precede fresh review reservation. Independent
asynchronous checks retain
FIFO positions and are refreshed at the existing polling interval. Evidence is
bound to the revision, head SHA and base branch; obsolete responses cannot open
a newer target. Waiting or failed CI creates no review, session or worktree and
consumes no review Worker or attempt. API errors close the gate and honor rate
limits. Restart discards transient admission evidence and queries again. A complete
snapshot must show no unresolved native review thread from any author; outdated
threads still block. A pending round and no current-target approval are also
required, so constant readiness alone does not repeat completed work.

After worktree preparation, each fresh launch checks the current PR, CI and
conversation state again,
then rechecks stored target and cancellation after the await. A regression defers
preparation, releases capacity and preserves the review/session/budget. CI changes
alone do not create a revision or repeat completed reviews. CI operations share
the coordinator's cancellation and shutdown ownership. An active agent is not
canceled merely because new CI is later registered or rerun.

The [requirements](../../../../docs/spec/daynight-review.md#r5-轮询与审查资格) own pass and
empty-CI policy. The [GitHub observation decision](2026-10-17-github-observation.md)
owns complete CI evidence, including approval-blocked workflows without jobs.

The [conversation-cycle decision](2026-10-21-review-conversation-cycle.md) partially
supersedes the original trigger and completion coordination. A verified COMMENT
with real review/thread identities arms one durable follow-up consumed when all
conversations resolve, even with no new commit or before an open count was ever
observed. It coalesces with a newer target. Existing exact-target approval remains
settled after description edits. Reusing a recorded approval for pending work
requires a fresh exact-remote-ID `APPROVED` match. Same-round reconciliation can
bypass the conversation gate only with actual captured-round publication or a
valid matching pending draft under its original publisher. Failed attempts with
no publication keep waiting for unrelated feedback; a changed reader may confirm
the original actor's submitted result but cannot continue its pending draft.
Marker acceptance and process exclusion save pending confirmation before remote
verification; failed lookups retry read-only across restart without another model
attempt.

Observed Draft/closure cancels the active attempt. New head/target revisions wait
for current execution and remain pending after its captured revision completes.
The existing store owns budget consumption, suppression, retries and immutable
revision attribution. Preparation failures do not consume an agent attempt.
Retry delays grow exponentially to a ten-minute cap. An uncertain Git command or
agent stop blocks reuse and cleanup of its resources.

The [bundled review skill](2026-10-20-bundled-review-skill.md) adds discovery
before the review child within the same attempt and overall deadline. The
supervisor retains one live child per attempt. It must exclude the discovery
execution before the store can clear that exact PID/identity and register the
review child. Cancellation between phases launches no new child; uncertain
discovery exclusion keeps the same resource and lock barriers as an uncertain
review execution.

The coordinator owns a lifetime cancellation signal in addition to the caller's
signal. Internal fatal errors cancel pending repository commands and PR work
before awaiting them. Error diagnostics retain repository/PR/review context and
causes. A failed cleanup diagnostic write preserves both the Git error and the
database error.

Startup and release follow the
[stale-lock recovery decision](../bug-fix/2026-10-18-stale-instance-lock-recovery.md).
A live or unconfirmed lock owner refuses startup; a confirmed dead CLI owner
permits automatic lock recovery. That recovery does not exclude old agents or
tools: interrupted reviews and unresolved pending cleanup block their affected
PRs. Reopen observations retain the cleanup marker and error until cleanup
operations conclusively stop and agents are excluded; an open PR cannot erase
the restart barrier. Polling and other PRs in the same repository continue, as do
other repositories. Uncertainty
keeps the lock and recorded state on shutdown. With explicit process exclusion,
interrupted state reconciles against its original captured target and session;
saved PIDs are never used as termination targets. Orderly shutdown closes SQLite
and releases only its own lock after managed operations are safe.

The original coordination decision required manual lock removal after every
abnormal run. Its premise remains valid: an absent CLI cannot prove that all
its agents and tools stopped. The recovery decision separates that resource-use
uncertainty from the existence of the CLI that owns the instance lock, allowing
quiescent crashes to restart directly while preserving the original exclusion
requirement for unresolved work.

Agents obey a foreground-tools contract: finish/reap tools and stop services
before returning. Normal unforced exit with drained streams is evidence under
that contract, rather than OS containment of arbitrary descendants. POSIX uses
a referenced child process group with pipes and no `unref`; TERM/KILL targets
the current group, with zombie-only groups distinguished from executing members.
A signal-zero probe returning `EPERM` also reaches the existing exact-PGID status
inspection: only an absent or entirely zombie group has no executing members.
A live row preserves the original permission denial. Inspection or parse errors
continue to retain uncertain execution.
Windows cancellation uses `taskkill /T /F` while the current wrapper is live.
Canceled roots that disappear before tree termination, failed stops and abandoned
capture remain uncertain. A definite command-not-found launch is recorded
separately: the Windows wrapper PID does not imply that an agent started, and
confirmed wrapper closure permits ordinary retry. No post-crash tree
reconstruction is attempted.

The relevant platform contracts are
[Node process groups](https://nodejs.org/api/child_process.html#optionsdetached),
[Node close](https://nodejs.org/api/child_process.html#event-close),
[POSIX kill](https://pubs.opengroup.org/onlinepubs/9799919799/functions/kill.html)
and [Windows taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill).
Published [Apple XNU group signaling](https://github.com/apple-oss-distributions/xnu/blob/ac9718fb1af618d5ce8678d0dc6e8a58f252216f/bsd/kern/kern_sig.c#L1703-L1719)
filters zombie members and can return POSIX `EPERM` when no eligible member
remains. This is published release-family evidence; native tests establish the
behavior on the actual runner build.

## Alternatives

**Select the first database candidate whenever a slot opens.** Number ordering
lets a continuously changing PR repeatedly bypass other eligible PRs. FIFO
admission preserves waiting order while coalescing each PR's newest revision.

**Use only the caller's cancellation signal.** An internal scheduling failure
can otherwise wait forever on a poll whose caller remains active. A coordinator
lifetime signal gives all started work one explicit shutdown boundary.

**Require independent OS proof for every Windows natural exit.** `taskkill /T`
needs a live tree root; closed stdio does not enumerate arbitrary descendants.
Universal containment would require stronger native process infrastructure.
The selected foreground contract supports ordinary review tools and keeps
abnormal execution visible, without changing the single-process CLI design.

**Reserve a review while waiting for CI.** This occupies review capacity and
creates retained work before it can run. Separate ephemeral admission lets ready
PRs proceed and keeps CI waiting outside agent attempt accounting.

## Consequences

Real SQLite tests exercise admission, revisions, retry budgets, failure isolation,
recovery and shutdown. The
[fairness validation decision](../testing/2026-10-19-deterministic-coordinator-fairness.md)
uses controlled clock, CI and worker boundaries to distinguish queue ordering
from independently changing readiness. A local Git origin plus a controlled
Copilot process and production process supervisor verifies the combined
review/re-review/closure lifecycle. Compiled-entry tests verify real state
creation, singleton refusal and signal cleanup without remote credentials.

The CLI is operational after configuration loading. Native CI and designated
live Copilot/GitHub acceptance remain distinct evidence. Detached services or
processes escaping the supported foreground contract require a different
execution design; normal process closure is not presented as a general sandbox.
