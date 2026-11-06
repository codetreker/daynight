# Agent Note: Authentication Grant Lock Acceptance

Status: implemented

## Problem

An admitted attachment upload can overlap a project membership removal. A
browser and installed CLI acceptance run must verify both the upload and access
withdrawal while respecting the service's transaction and cleanup guarantees.

## Decision

The [combined authentication journey](2026-10-23-authentication-combined-acceptance.md)
keeps its real paused upload and separate interrupted-upload checks on both
native and container targets. A read-only probe binds the exact project grant
row to its waiting DELETE and blocking attachment transaction through PostgreSQL
lock evidence. The body remains incomplete and the member remains present while
the wait is observed. The upload must return 201 and removal must return 204;
subsequent shared requests fail and the private project remains accessible. Both
the target and shard receipt validators require that evidence.

The earlier journey required removal to commit while an admitted body remained
incomplete because authorization then used a short snapshot. The
[attachment serialization decision](../architecture/2026-11-06-attachment-task-deletion-serialization.md)
retains the grant lock through the file and metadata transaction, so removal
must instead wait until the admitted mutation completes.

## Alternatives

**Accept an elapsed-time delay as proof of a wait.** A slow request could be
waiting on unrelated work or fail before reaching the grant row. The database
observation identifies the waiter, blocker and target grant instead.

**Move the race entirely to server acceptance.** A built-binary server test can
prove lock ordering, but it does not preserve this journey's existing native and
container browser, installed-CLI, interrupted socket and cleanup coverage.

## Consequences

The acceptance target needs read-only access to its owned PostgreSQL lock
metadata and retains bounded cleanup of the upload and concurrent removal.
Database and transport failures fail the journey without asserting a lock wait
or inventing a mutation result.
