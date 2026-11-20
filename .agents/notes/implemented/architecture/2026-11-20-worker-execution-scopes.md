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
until all original owners report confirmed closure and durable save.

Owners close admission synchronously and stop concurrently with bounded
observations. A timeout preserves unknown responsibility. Explicit reconciliation
rechecks failed owners without repeating completed cleanup or replaying business
operations. Failed observation promises are not permanent resource facts.
A Task producer that ignores cancellation cannot hold its native stop request
behind the business mutation queue. Independent stop verifies the original
launch identity and boundary without changing cleanup state or releasing leases;
the producer still prevents storage closure and scope reconstruction.
Management-controlled stopped and blocked scopes retain reporting and the
original lock; closed scopes report cached telemetry without spawning probes.

A controlled Node launcher establishes and reports its native boundary before
receiving permission to execute a command. The parent persists the original
birth proof and acquires the Windows Job lease before release. Git and short
commands share this mechanism inside a Worker scope. Durable per-resource events
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
