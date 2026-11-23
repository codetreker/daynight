# Agent Note: Local worktree traversal checks

Status: implemented

## Problem

Worktree cleanup repeatedly read the complete ownership and Git metadata set
and every open ancestor for each entry. The repeated I/O grows with both file
count and depth even though the manifest and matching Git registration already
identify the resource for the cleanup attempt.

## Decision

The Git caller verifies ownership and its metadata snapshots at the boundaries
of content removal. The walker checks the current directory path and handle,
keeps the root and its top-level `.git`, and retains the POSIX ownership,
device, read/search and descriptor-bound permission recovery rules described in
the [worker design](../../../../docs/design/daynight-worker.md#git-工作区与资源身份).
It does not recheck the complete ancestor chain or global ownership per entry.
Explicit recording source disposal still supplies its independent root and
source identity guard before each mutation.

This narrows the per-entry checks in the earlier [read-only directory cleanup
decision](../../archived/bug-fix/2026-11-04-worker-readonly-directory-cleanup.md)
while retaining its permission and link protections.

## Alternatives

**Keep global and ancestor checks per entry.** These detect some concurrent
changes sooner, but multiply metadata reads with file count and depth while
still leaving a race between path checks and filesystem operations.

**Descriptor-relative native traversal.** This could strengthen isolation from
concurrent path replacement, but Node has no portable openat/unlinkat API and
it would add a native dependency beyond the stopped-process cleanup contract.

## Consequences

Metadata checks no longer scale with every entry on the Git caller. Local checks
can detect obvious replacement but are not an atomic fence against hostile or
escaped concurrent writers. Submitted operations and handle closes still join
on cancellation, and errors and partially removed content remain observable.
