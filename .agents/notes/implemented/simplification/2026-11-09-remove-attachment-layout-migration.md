# Agent Note: Remove Attachment Layout Migration

Status: implemented

## Problem

The attachment runtime uses project/shard/task directories, but the server also
carried an offline converter for an earlier task-only directory format. That
converter required a command, dedicated PostgreSQL maintenance sessions and
snapshots, durable manifests, filesystem recovery states and their test matrices.
The service has not been deployed, so there is no supported installed population
whose attachment directories require that transition.

## Decision

The server supports the current
`task-attachments/<projectId>/<taskId[:2]>/<taskId>/<path>` layout directly. The old
layout converter, its command, maintenance DAO contract, PostgreSQL adapter,
assembly factory and dedicated tests are removed. The executable starts with no
arguments; supplied arguments fail before configuration, database connections or
HTTP listeners are initialized, without echoing their contents.

This supersedes only the conversion and recovery portion of the archived
[project-grouped attachment layout decision](../../archived/architecture/2026-10-24-project-sharded-attachment-layout.md).
That decision addressed source/destination UUID collisions and preserving old
bytes while changing directories. Its business-owned project grouping, UUID
shards, logical attachment identity and generic bucket/path storage remain in
use. The [attachment requirements](../../../../docs/spec/daynight-task-attachments.md)
and [design](../../../../docs/design/daynight-task-attachments.md) own current
behavior and address construction. PostgreSQL schema upgrades retain their own
migration mechanism.

The earlier [record-validation isolation decision](../testing/2026-11-06-attachment-record-validation-isolation.md)
retains the rationale for separating fixed DAO facts from real filesystem
mechanisms. Its converter and tests have no remaining runtime responsibility.

## Alternatives

**Retain and optimize the converter tests.** Replacing additional database
fixtures could reduce test preparation, but it would retain a maintenance
protocol and recovery state machine for an unsupported data transition.

**Remove only the slow tests.** The command and its durability/recovery promises
would remain callable without their dedicated failure and interruption proofs.
Retiring the capability removes those promises together with their tests.

## Consequences

Normal attachment uploads, reads, deletes, project/shard isolation, public paths,
and paired PostgreSQL/directory backup and restore retain their behavior. The
removal reduces production and verification work associated with old-layout
conversion. Package elapsed time cannot be treated as an equal reduction in
whole-job CI time because Go packages execute concurrently.

The executable no longer converts task-only trees or resumes their operation
records. A future requirement to import another physical layout needs a separate
scope and data-preservation decision. Existing archives remain historical records
of the former converter and do not define a supported command.
