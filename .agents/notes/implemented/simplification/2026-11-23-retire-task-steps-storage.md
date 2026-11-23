# Agent Note: Retire Task Steps Storage Code

Status: implemented

## Problem

After the public interfaces and application services retire, dedicated Steps
DAO contracts and SQL retain an unsupported capability. Ordinary Task and
Thread operations still need shared header reads, revision touches and transaction
semantics; removing the old table requires a separate migration and deployment.

## Decision

Remove Steps reader and writer methods, projections, model and PostgreSQL SQL.
Keep `TaskHeader`, `ReadTaskHeader`, `TouchTask`, shared errors and ordinary Task
synchronization. Replace Step fixtures in shared transaction tests with ordinary
Task operations while preserving their commit, cancellation and rollback proofs.
At that stage the schema, migration ledger and historical migration remained unchanged. The subsequent [data retirement](2026-11-23-drop-task-steps-data.md) removes the table.

This follows the [application retirement](2026-11-23-retire-task-steps-application.md).
The [requirements](../../../../docs/spec/daynight-task-steps.md) and
[design](../../../../docs/design/daynight-task-steps.md) own the current boundary.

## Alternatives

**Retain the unused DAO until table deletion.** This keeps unsupported code and
contracts in production and couples code cleanup to irreversible data migration.

**Delete the table together with the DAO.** This combines code cleanup with the
separate upgrade, rollback and old-process drain needed for data removal.

## Consequences

Production no longer reads or writes Steps rows. The subsequent data retirement removes existing data; the historical schema and
checksum remain. Neither code change establishes a production deployment. Ordinary Task operations retain their
revision, synchronization and transaction guarantees.
