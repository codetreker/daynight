# Agent Note: Persistent Task Attachment Volumes

Status: implemented

## Problem

Attachment metadata lives in PostgreSQL while bytes live under the configured
local storage root. Container-layer files disappear during normal recreation,
leaving valid metadata without its contents. Disposable test deployments also
need independent file roots and complete cleanup. Backing up only one medium
cannot preserve a usable attachment set.

## Decision

Both [localhost](../../../../deployment/localhost/compose.yaml) and
[dev-ci](../../../../deployment/dev-ci/compose.yaml) mount their Compose project's
`attachment-data` named volume at `/var/lib/daynight/storage`. The server keeps
its existing `DAYNIGHT_STORAGE_ROOT` and UID/GID `10001:10001`. Its production
image prepares that directory with the service ownership. Docker's default
empty-volume initialization copies the image directory into the volume; the
[volume documentation](https://docs.docker.com/engine/storage/volumes/#mounting-a-volume-over-existing-data)
describes initialization and the
[pinned Moby implementation](https://github.com/moby/moby/blob/af898abe44662d9554fb15ee4d4a7307f1b8e315/container/container_unix.go#L385)
preserves the source root ownership and mode. No privileged startup process is
needed. Real-container checks verify the resulting ownership and actual writes.

Normal restart, recreation and `down` retain PostgreSQL and attachment volumes.
`down --volumes` deliberately deletes both. Each dev-ci invocation has a unique
Compose project; its existing runner records all project-labeled volumes,
removes them and verifies absence. The runner needs no attachment-specific
cleanup branch. Fake-Docker fixtures record both volumes and make a surviving
attachment volume fail cleanup even when Compose reports successful teardown.

The [attachment check](../../../../deployment/dev-ci/tests/attachments.mts) uses
two invocations of that runner and the unchanged production Dockerfile. Through
the gateway it creates projects/tasks, uploads nested text, binary and HTML/CSS
files, and checks exact metadata, byte hashes, downloads and inline relative
resources. It checks UID 10001 writes on fresh volumes, server stop/start and
full recreation, rediscovers changed gateway ports and proves project isolation.
Cleaning one project must leave the other readable and writable. All project
resources and image tags must be absent after final cleanup.

The [operator procedure](../../../../deployment/localhost/README.md#persistence-and-backup)
stops the server and other writers before capturing a matching `pg_dump` and
attachment-root archive. A one-off container from the production image runs
`tar` with the normal service user. Restore initializes fresh volumes, restores
SQL and files, rotates affected project task-cache epochs while writers remain
stopped, then starts the server and verifies existing reads/previews and new
writes. The [summary API decision](2026-10-24-task-summary-window-api.md) owns
cache history invalidation; ordinary restarts keep the epoch unchanged. The real-container check exercises the same ordering after
destroying its owned source volumes. Test archives and dumps are removed;
source-bound receipts remain with the PR or CI evidence.

The [adopted attachment design](2026-10-21-task-attachment-storage-design.md)
continues to own K1: filesystem and PostgreSQL mutations are non-atomic. Paired
backup captures the stopped state and does not repair an earlier inconsistency.
No recovery platform, coordinator, ledger or scanner is introduced.

## Alternatives

**Keep files in the container layer.** Normal rebuilds would retain metadata in
the database volume while losing bytes. This fails ordinary attachment
persistence, independently of the accepted cross-store failure window.

**Change ownership through a root entrypoint.** The image already owns the mount
directory as UID 10001, and Docker preserves that ownership on fresh-volume
initialization. A privileged startup wrapper would add runtime behavior without
solving an observed permission problem. Actual fresh-volume writes establish
whether the existing image contract remains sufficient.

**Share the localhost attachment volume with tests.** That couples disposable
cleanup and test writes to retained application data. Compose project-scoped
volumes provide the same layout with explicit resource ownership and concurrent
test isolation.

**Automated backup or cross-store reconciliation.** These add scheduling,
durable state and recovery policy beyond a manual matching-pair procedure.
K1 remains accepted; this delivery verifies normal persistence and restoration
without claiming transactional consistency.

## Consequences

Normal deployment updates preserve attachment bytes along with their metadata.
Operators must retain and restore both backup artifacts and keep all writers
stopped while capturing them. An explicit volume teardown destroys both media.
Files uploaded before this volume mount existed in an old container layer are
not migrated automatically; operators must capture them before replacing such a
container if that data is needed.

The test uses Node.js 24 standard libraries and existing Docker tooling without
host workspace dependencies. It builds two disposable production images and
owns only their runner-derived project resources. Receipts name those resources
before lifecycle actions; failures remain failures and cleanup is scoped.
Current runtime validation is for Linux Docker volumes. A different storage
driver or deployment model needs its own permission and persistence evidence.

Deployment tests do not establish CLI and browser management behavior or
cross-layer acceptance.
