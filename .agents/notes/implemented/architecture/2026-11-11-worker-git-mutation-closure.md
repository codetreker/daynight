# Agent Note: Worker Git Mutation Closure

Status: implemented

## Problem

A bounded Git result can arrive while a Worker mutation still owns a child or
output pipe. Releasing its project or task gate at that point allows cleanup,
retry or a successor to overlap the original writer, even if the path is absent.
Shutdown must also retain preparations that have not yet started Git.

## Decision

Worker clone, fetch, worktree add and remove, and private ref cleanup use the
[owned Git port](2026-11-11-owned-repository-git-local-closure.md). Their
original operation waits for local closure after any early pending result and
preserves command, cleanup and reporting errors. Read-only Git calls retain the
bounded runner. The manager closes admission, cancels and joins preparations and
handles before removing its private hooks. Execution capacity remains governed
by independent Agent stop observations; file and same-task responsibilities
remain until their actual operations settle.

## Alternatives

**Release on the bounded result or an absent path.** Neither proves the original
child and pipes have closed, so a later mutation can overlap the old one.

**Wait for a complete process-tree proof.** Existing Node and platform mechanisms
cannot prove escaped or stdio-independent descendants have stopped. Requiring
that proof would retain gates indefinitely without establishing it.

## Consequences

A local resource that never closes can hold its gate and shutdown indefinitely.
Local closure does not prove escaped descendants have stopped; they can still
write after handover. The existing worktree format and independent execution
capacity remain unchanged. The [Worker design](../../../../docs/design/daynight-worker.md#git-工作区与资源身份)
describes the resulting responsibilities.
