# Agent Note: Rebuildable Worker Execution Scopes

Status: implemented

## Problem

A Worker must stop every producer and native writer while preserving the original
claims, worktrees, sessions and uncertain operations. A single cancellation
signal couples management reporting to execution. Sequential shutdown can skip
an owner after another fails, and unbounded joins can prevent useful stop
observations. Reusing an aborted runtime cannot safely reopen execution.
Short-lived Git and capability commands also need responsibility that survives
an Error object's lifetime and a process restart.

## Decision

The management root owns the instance lock, verified identity and main database.
An independent execution scope owns cancellable producers and native resources.
Normal startup and exit use the same create/stop path exposed to lifecycle
integration. A replacement needs new objects and a new signal, and is forbidden
until all original owners report confirmed closure and durable save. Startup
constructors are owned before their first asynchronous operation: cancelling a
wait retains the original constructor and cleanup of its late result.

Owners close admission synchronously and stop concurrently with bounded
observations. A timeout preserves unknown responsibility. Explicit reconciliation
rechecks failed owners without repeating completed cleanup or replaying business
operations. A timed-out stop attempt remains owned until it settles; subsequent
reconciliation joins that attempt instead of launching concurrent cleanup. Failed
observation promises are not permanent resource facts.
Management reconciliation joins command producers and their event writes before
re-observing retained native boundaries, output writers and durable closure.
A settled producer's historical cleanup error cannot skip this reconciliation.
It uses the original resource generation and never reruns the command; missing
proof or a required lease still retains unknown responsibility.
A Task producer that ignores cancellation cannot hold its native stop request
behind the business mutation queue. Independent stop verifies the original
launch identity and boundary without changing cleanup state or releasing leases;
the producer still prevents storage closure and scope reconstruction.
Management-controlled stopped and blocked scopes retain reporting and the
original lock; closed scopes report cached telemetry without spawning probes.
Historical initialization and joined archive failures remain diagnostics rather
than active resource claims. Once closure is confirmed, an accepted rebuild may
start the next generation without rethrowing those historical failures. Ordinary
exit still reports them, and unjoined management cleanup remains a separate
barrier to replacement.
Assistant application ownership includes detached guarded actions after the factory
returns. Bot preparation owns probe cleanup and aliases even before a launch is
submitted; failed cleanup retains the host stores and locks. The Reviewer host
also belongs to the scope; its Git, GitHub and Copilot phases share the launcher
and join streamed output writers before recording resource closure.
The Reviewer retains its original close operation when command cleanup cannot
be confirmed. Reconciliation must prove every retained stop cause and complete
that close operation before releasing its lock; a settled host Promise or one
confirmed cause in a mixed failure cannot establish closure.

A controlled Node launcher establishes and reports its native boundary before
receiving permission to execute a command. POSIX uses a private IPC gate in the
original process group. Windows creates the primary thread suspended, assigns its
Job and persists the original birth proof before resuming the launcher. Git and
short commands share this mechanism inside a Worker scope. A POSIX launcher
remains a live original process after returning its command result and through
SIGTERM escalation. Stop still rechecks its birth proof before signaling the
group; only a group containing solely that guardian can skip the remaining
grace period. A command result or closed output pipe cannot prove that a descendant
which closed its inherited streams has exited. Loss of parent IPC makes the verified group leader
close its own group instead of abandoning its descendants.

Controller bootstrap also waits for its original launch record and birth proof.
A POSIX Controller can outlive its original Host and be reparented. If its command
identity becomes uncertain while birth and group still match, shutdown only
observes it within the original deadline, regardless of its current parent.
Signaling still requires complete identity, and uncertainty cannot prove closure.
Windows Job and process
handles transfer explicitly to that execution owner before its thread resumes.
Failed pre-dispatch cleanup also remains in that owner, so a failed birth-record
write cannot discard the only handles capable of closing the original child. Durable per-resource events
bind the original Worker identity and generation, and monotonic sequence numbers
prevent late writes from replacing newer facts. Re-observation must finish a
failed directory persistence barrier before acknowledging existing terminal bytes.

The [Worker design](../../../../docs/design/daynight-worker.md#管理根与执行作用域)
owns interfaces, budgets and the owner inventory. The
[Bot runtime decision](2026-11-05-worker-bot-runtime.md) continues to own Bot
execution evidence and recovery provenance. The
[Windows proof decision](../bug-fix/2026-11-05-windows-native-process-proof.md)
continues to own process identity; a PID observation alone is insufficient.

## Alternatives

**Cancel the entire Worker and restart it.** This loses the management channel
needed to report blocked stopping and couples storage locks to each attempt.
Keeping the management root permits bounded observation without admitting new work.

**Keep command cleanup only in WeakMap callbacks.** Such callbacks help the
original caller observe late stream closure, but cannot preserve responsibility
after restart. The durable journal retains native boundary identities independently.

**Launch the command and attach ownership afterward.** This leaves a window in
which user code runs before its boundary is saved. The controlled launcher adds
a process and IPC handshake, but makes persistence failure prevent command release.

**Let the launcher exit with its direct child or on SIGTERM.** This can leave
signal-resistant or closed-stdio descendants without a live original proof for
forced-stop escalation. Retaining the launcher preserves that proof. Killing a
group solely by its numeric PGID would discard the existing identity guarantee.

## Consequences

Native proof capture and the launcher add startup cost. Command-specific total
budgets remain authoritative; HTTP request limits do not shorten Git timeouts.
Missing proof or leases can block recovery and require external repair rather
than allowing a guessed process kill. Journal records remain private and are
retained with their original evidence.

These mechanisms do not themselves implement persistent disable intent, cloud
admission or Controller dispatch fencing. Lifecycle integration must consume
those authorities before advertising complete disable/resume support. Provider
and platform acceptance remains distinct from controlled mechanism tests.
