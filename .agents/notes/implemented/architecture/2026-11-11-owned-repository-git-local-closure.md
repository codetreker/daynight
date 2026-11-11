# Agent Note: Owned Repository Git Local Closure

Status: implemented

## Problem

A bounded Git command can report a timeout while its original child, inherited
output streams, or Windows stop helper still hold local resources. A caller that
hands those resources over on the bounded result can overlap an unfinished
mutation. A bounded result alone cannot establish that those resources closed.

## Decision

The owned Node Git port separates its bounded outcome from a joined settlement.
Settlement waits for the original child and each created output stream, including
an asynchronous Windows taskkill helper and its streams, to emit close. After the
cleanup grace the outcome reports pending while ownership remains with the
caller. Output beyond the limit is drained without being retained. Stop and
stream errors remain observable, including errors arriving after the pending
outcome. Ordinary repository Git reads retain their bounded API and share the
same command, environment, limits, and diagnostic policy.

## Alternatives

**Release responsibility at the cleanup deadline.** Destroying streams and
unreferencing the child keeps the caller bounded, but does not establish that the
original resources closed and can allow mutation to overlap resource handover.

**Restore native Windows Job ownership.** The [reversal](../simplification/2026-11-11-revert-native-windows-git.md)
removed its platform-specific maintenance cost. Local closure is a narrower
observation and does not restore sealed process-tree termination.

## Consequences

A caller can remain pending indefinitely when a local resource never closes.
Local closure does not prove that descendants which escaped or detached their
stdio have stopped; they can still mutate resources after handover. The port does
not itself change Worker callers or introduce a process inventory. The
[repository Git design](../../../../docs/design/daynight-project-task.md#git-定位与仓库身份)
describes both execution paths.
