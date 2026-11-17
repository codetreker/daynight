# Agent Note: Allow automatic privileged worktree cleanup

Status: implemented

## Problem

An owned worktree can contain directories created by another account. Ordinary
cleanup cannot always remove those directories, leaving the original Git
registration and cleanup responsibility in place after the execution has stopped.
A saved cloud target also does not by itself prove what a Worker has applied.

## Decision

Automatic Worker cleanup snapshots the committed `enableSudoCleanup` value and
its actual source revision for each attempt. Ordinary removal runs first. After a
verified ownership check and a filesystem permission obstacle, Linux and macOS
verify the system mount inventory and reject mounted targets or descendants, then
use a non-interactive shell command to remove the original target: root runs rm
directly, while other users invoke sudo. The ordinary Git process removes the
registration and a fresh observation verifies both resources are absent. Manual
cleanup retains its ordinary behavior. The [Worker design](../../../../docs/design/daynight-worker.md#归属清单与格式转换)
records the execution boundary and [cleanup outcome decision](../architecture/2026-11-12-worktree-cleanup-outcome.md)
retains the observation and error settlement rules.

Schema 7 recognizes the optional boolean from the raw target preserved by the
[unknown configuration decision](../architecture/2026-11-17-worker-unknown-configuration-preservation.md).
The schema 6 upgrade validates the old known contract first, then creates a new
pending item when the field is present. Existing actual values retain their true
sources; absence creates no item or bootstrap field.

## Alternatives

**Require manual cleanup.** This leaves a stopped execution's worktree and
capacity responsibility until an operator intervenes even when non-interactive
sudo is available.

**Introduce a privileged helper or cross-process lock.** The selected shell
approach avoids another executable, handshake and recovery protocol. It does not
establish mutual exclusion with a command surviving a forced Worker restart.

**Probe sudo before removal.** A separate probe cannot establish that the actual
command will be permitted later. The removal command itself checks the current
non-interactive authorization.

## Consequences

The Worker can recover permission-blocked owned worktrees without a password
prompt, while preserving branches and external link targets. Failed commands
retain both the ordinary failure and the command error for existing retry and
diagnostics. Identity, device, Git and ordinary I/O failures do not authorize
privileged removal. A partial recursive deletion can remove `.git` while leaving
other contents; if ownership can no longer be proved, retries retain the error
and responsibility instead of deleting the remaining directory. Schema 7 cannot be read by a schema 6 binary; migration must
be saved before jobs start. The mount inventory is an observation and cannot prevent a concurrent external
mount after its check. A forced restart has no new cross-process exclusion.
