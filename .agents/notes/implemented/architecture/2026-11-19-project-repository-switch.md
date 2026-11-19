# Agent Note: Project Repository Switching

Status: implemented

## Problem

A Project needs to follow a corrected repository address or move to another
repository without losing its tasks and historical pull requests. Address spelling
alone cannot reliably distinguish a rename from a replacement, and updating the
address independently of its GitHub and Worker bindings can leave a mixed state.

## Decision

Preview and save classify the address using the existing identity rules and
permitted GitHub observations. Stable IDs override equivalent spelling. The
operator explicitly chooses whether an unverified target is treated as a switch.
The write rechecks the preview and its observed dependencies under the Project,
Team, authorization and connection locks. A true switch updates the address,
retires the Project connection and removes selected Worker cloud configuration
entries in one transaction. Historical PR sources remain independent. The
[server design](../../../../docs/design/daynight-server.md#项目仓库改址) owns
the transaction and observation contract.

The Web editor binds confirmation to the exact preview and keeps the decimal
versions as strings. Repository writes join the existing Project management
guard. Its unknown result remains guarded after readback because current state
cannot identify the original operation. Account- and Project-bound change
notifications refresh the affected readers through their existing controllers,
which preserves independent settings and Worker drafts. Settings refresh intent
survives read failure and cancellation until an authorized read merges the
resource, so recovery cannot discard a draft or replace its concurrency version.
Access revocation still clears private state. The
[settings design](../../../../docs/design/project-settings.md#仓库改址) owns
Web presentation and read ownership.

## Alternatives

**Disconnect and update Worker configuration after saving the address.** A
failure or competing write between operations would leave the new address with
old bindings or only a subset of Workers updated.

**Treat every different address as a new repository.** Renames and equivalent
transport forms would unnecessarily stop synchronization and remove selections.
An explicit choice is required when the available evidence cannot establish
identity.

**Refresh the whole page after saving.** Reloading would discard independent
settings drafts and reading context. Targeted notifications retain those owners
and invalidate the GitHub installation proof that belongs to the old address.

## Consequences

The Team and connection locks serialize the dependent decisions, while network
observation stays outside the transaction. Worker removal covers its selection
snapshot; later selections remain ordinary independent writes. Configuration
application is asynchronous and can stop existing executions. A lost commit
receipt remains unknown and cannot be recovered by automatic replay.
