# Agent Note: Server File and stderr Logging

Status: implemented

## Problem

The server needs a persistent local log while retaining stderr for process and
container supervisors. Concurrent processes, rotation failures and shutdown
must not silently corrupt history or turn a failed output into successful service.

## Decision

Normal startup locks a persistent control file under the selected root before
opening the active log. A synchronous writer sends each encoded JSON record to
both stderr and the file, rotates at 100 MiB and retains ten numbered archives.
The command cancels on the first output failure and checks its independent error
latch through shutdown. It closes the file after producers stop and releases the
lock afterward. The command handles a broken stderr pipe as a write failure, and
transport draining includes request-completion logging after connection hijack.
Backup verification uses stderr only. Container deployments own a separate
writable log volume for each server instance.

## Alternatives

**Use a rotating library with background maintenance.** Its maintenance thread
can discard cleanup failures and cannot be joined on Close, so it cannot satisfy
the required failure and ownership lifecycle.

**Use a PID file or a process-local mutex.** Neither supplies kernel-managed
exclusive ownership and crash recovery for independent processes.

## Consequences

Logs survive ordinary restarts and stderr remains available to supervisors.
Synchronous output can block on a stalled sink and does not provide per-record
fsync durability. A server instance needs its own root and log directory; an
absolute storage directory can still be shared. Operators must provision write
access and include the log volume in their deployment's resource cleanup.
