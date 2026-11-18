# Agent Note: E2E process group observation

Status: implemented

## Problem

The product E2E stop supervisor scans Linux process identities before signaling
an owned group. During process exit, a `/proc/<pid>/stat` read can return a
complete record with process group `-1`. The kernel uses that value when it
cannot lock the task's signal state; it does not identify a process group. A
digit-only parser rejects this valid observation and can prevent unrelated owned
commands from completing cleanup.

## Decision

The observer recognizes a complete record with group `-1` as temporarily
unavailable and reopens the PID's stat path with a bounded retry. It accepts a
subsequent valid identity or confirmed absence; persistent unavailability fails
explicitly. Other malformed records still fail immediately. Existing start,
group, boot and command checks remain necessary before signaling.

Linux reads the task state before obtaining its signal lock, so the state alone
cannot resolve an unavailable group. The kernel's [stat implementation](https://github.com/torvalds/linux/blob/98f7e32f20d28ec452afb208f9cffc08448a2652/fs/proc/array.c)
initializes the group to `-1` and fills it only after locking the signal state.
The [product E2E decision](../testing/2026-11-08-self-contained-product-e2e.md)
owns the broader recovery and process-proof requirements.

## Alternatives

**Treat group `-1` as a stopped process.** The record does not establish that
the original group has stopped or that a subsequent PID observation is the
same instance. A fresh observation preserves the existing proof requirements.

**Ignore malformed observations during the group scan.** Skipping an unknown
member could incorrectly establish that the group is empty and hide a real
failure. Invalid records and persistent unavailable identities remain errors.

## Consequences

Transient exit observations no longer immediately fail cleanup. A persistent
unavailable group delays and then fails the operation rather than authorizing a
signal or claiming a stop. A historical CI error without recorded stat fields
cannot be attributed to this particular exit race solely from its error text.
