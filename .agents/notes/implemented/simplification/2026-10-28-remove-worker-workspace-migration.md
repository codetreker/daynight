# Agent Note: Remove Worker Workspace Migration

Status: implemented

## Problem

Task-title display and stable local resource ownership require one current
workspace format. A separate local format-upgrade facility adds a public command,
backup inventory, interrupted-operation state and recovery procedure outside
normal task execution. That maintenance surface is unnecessary when historical
workspace conversion is not a required capability.

## Decision

The worker retains title-prefixed Herdr labels and the four stable
Project/task/claim/worktree coordinates defined by the [workspace naming
decision](../architecture/2026-10-28-worker-workspace-names.md). Resource operations
use current-format validation and the ordinary execution, recovery and cleanup
paths.

Workspace conversion, its command and rollback option, backup and manifest
implementation, startup and manual-management block, migration-only diagnostics
and tests are removed. Startup does not replace them with automatic conversion.
The [worker design](../../../../docs/design/daynight-worker.md#workspace-名称与身份)
owns the resulting runtime structure.

This supersedes only the conversion part of the naming decision. Its original
reasoning remains there: the converter preserved unfinished work across a local
identity-format change and avoided editing Herdr's coupled history fingerprint.
The four-ID identity, display escaping, stable agent hash, title synchronization
and lifecycle checks remain adopted decisions.

## Alternatives

**Keep a separate conversion command.** It would retain the operator sequence,
maintenance persistence and recovery code for a capability that is no longer
required by the worker's supported resource contract.

**Move conversion into startup.** It would remove an explicit command invocation
but keep conversion, backup and interrupted-upgrade recovery as prerequisites of
normal startup. Removing the capability also removes those dependencies.

## Consequences

The CLI and runtime expose only ordinary worker operations. Current-format
resource validation continues to report invalid ownership and bindings;
historical labels and markers are not converted or accepted through compatibility
branches. Removing this facility does not inspect, delete or rewrite existing
machine state, and it does not change server database migrations or the native
conversation recovery contract.
