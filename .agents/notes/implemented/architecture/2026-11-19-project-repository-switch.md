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

Repository operation diagnostics record the Project, phase, classification and
transaction outcome without repository addresses or credentials. Worker row
counts are recorded as committed only when transaction completion confirms it;
an unknown commit reports the transaction's provisional count instead.

## Alternatives

**Disconnect and update Worker configuration after saving the address.** A
failure or competing write between operations would leave the new address with
old bindings or only a subset of Workers updated.

**Treat every different address as a new repository.** Renames and equivalent
transport forms would unnecessarily stop synchronization and remove selections.
An explicit choice is required when the available evidence cannot establish
identity.

## Consequences

The Team and connection locks serialize the dependent decisions, while network
observation stays outside the transaction. Worker removal covers its selection
snapshot; later selections remain ordinary independent writes. Configuration
application is asynchronous and can stop existing executions. A lost commit
receipt remains unknown and cannot be recovered by automatic replay.
