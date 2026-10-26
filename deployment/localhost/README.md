# Localhost deployment

This Docker Compose stack builds and runs the authenticated task dashboard,
project/task HTTP API and PostgreSQL together. Docker Engine 28 or newer, Linux
containers and Docker Compose 2.20 or newer are required. Linux hosts and macOS
with Docker Desktop using Linux containers can run this stack. The first build
accesses Docker Hub, the npm registry and the Go module registry. No host Go,
Node.js or PostgreSQL installation is needed. A registered UniAuth application
and its server-side credentials are required.

## Configure and start

From the repository root, copy the local configuration template:

```bash
cp deployment/localhost/.env.example deployment/localhost/.env
```

Set the following values in `deployment/localhost/.env` before starting:

| Variable | Required value |
|---|---|
| `DAYNIGHT_PUBLIC_ORIGIN` | Exact browser-visible origin, without a trailing slash, path, query or fragment |
| `DAYNIGHT_UNIAUTH_URL` | UniAuth gateway URL |
| `DAYNIGHT_UNIAUTH_APP_ID` | Registered UniAuth application ID |
| `DAYNIGHT_UNIAUTH_APP_SECRET` | Registered UniAuth application secret; keep this file private |
| `DAYNIGHT_UNIAUTH_CALLBACK_URL` | Registered callback URL on the exact public origin, for example `http://127.0.0.1:8787/auth/callback` |

The callback must have a canonical non-root path and no query or fragment. The
server registers that path and rejects collisions with application API, page,
asset and health routes during configuration validation. The `/login` and
`/setup` namespaces are reserved for the independent login and daily usage guide,
including all descendant paths. If a previous callback uses either namespace,
choose another canonical path such as
`/auth/callback`, update `DAYNIGHT_UNIAUTH_CALLBACK_URL`, and register the same full
callback URL in UniAuth before restarting. The example application values are
placeholders; supply credentials for the intended
UniAuth deployment.

Production public origins require HTTPS. The template explicitly enables
`DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN=1` for the loopback HTTP deployment. This setting
permits an HTTP main-site origin and its test Cookie policy.
`DAYNIGHT_ALLOW_LOOPBACK_HTTP` controls a separate UniAuth SDK rule: set it to `1`
only when the UniAuth gateway itself uses HTTP on a literal loopback address.
It defaults to `0` in the template because the example gateway uses HTTPS.
Neither setting disables authentication or project authorization.

`DAYNIGHT_TASK_SYNC_OVERLAP` defaults to `10s` in the template and Compose
configuration. It sets the server's task-sync lookback window and must be a
positive Go duration, for example `250ms`, `30s` or `1m30s`; invalid, zero and
negative values stop server startup. Keep the same value on all server instances.
The server applies the current window to subsequent task-sync requests; clients
cannot override it and keep their original task timestamp watermarks when it
changes. The authenticated task-sync API and project cache epoch are described
by the [task-sync design](../../docs/design/daynight-task-sync.md).

Start the stack:

```bash
bash deployment/localhost/up.sh
```

To use an npm mirror for the image build, pass it explicitly:

```bash
DAYNIGHT_NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/ bash deployment/localhost/up.sh
```

The default is `https://registry.npmjs.org/`. A host `.npmrc` does not configure
Docker build steps. The same variable is supported by `deployment/dev-ci/run.sh`.

The script requires the `.env` file and works from any working directory when
invoked with its path. It builds the frontend with Node.js 24 and pnpm 11.28.6,
embeds its generated assets in the Go 1.27.2 binary, recreates all three service
containers while preserving the PostgreSQL and attachment volumes, and waits up
to 120 seconds for their health checks. Build time is separate from that
readiness timeout. The final nonroot runtime image contains the server binary
and does not need Node.js. It prepares the required writable
`DAYNIGHT_STORAGE_ROOT` for UID/GID `10001:10001`. The Compose-managed
`attachment-data` volume mounts at that root. Docker initializes a fresh volume
from the image directory with its ownership, so the server writes as UID 10001
without a privileged startup process.

Open the configured public origin, `http://127.0.0.1:8787/` with the template,
and sign in through UniAuth. The dashboard provides project creation, member and
invitation management, personal access token management and task browsing.
Selecting a project opens `/projects/<projectId>`, with statistics, expandable
dependency graphs and task details. The shared task-title header offers a
three-item status menu on both detail tabs. Confirmation shows the task name,
source/target and timing consequences; Cancel and Escape send no request.
The automatic-execution switch shares the same per-task write gate. Details also
manage attachments. Use the CLI or API to create tasks and edit metadata. The
HTTP API uses the same origin at `/api/v1`.

Users see only member projects; a new project's creator becomes its administrator.
All members can read/write tasks and set status; administrators additionally
manage members and invitations. Existing projects need member records prepared
manually. Status does not grant execution, deployment or delivery authority.

To select a different host port, update `DAYNIGHT_PORT`,
`DAYNIGHT_PUBLIC_ORIGIN` and `DAYNIGHT_UNIAUTH_CALLBACK_URL` together in `.env`,
and update the callback registration in UniAuth. The equivalent Compose command,
and the remaining commands below, run from `deployment/localhost/` and load
that directory's `.env`:

```bash
docker compose up --build --force-recreate --detach --wait --wait-timeout 120
```

## Create project data

Sign in through the dashboard and create a personal access token in the account
page. The token is shown once. Read it without placing it in shell history:

```bash
read -r -s -p 'Daynight personal access token: ' DAYNIGHT_TOKEN
printf '\n'
```

Set `DAYNIGHT_BASE_URL` to the configured public origin, then create a project:

```bash
DAYNIGHT_BASE_URL=http://127.0.0.1:8787
curl --fail-with-body --header "Authorization: Bearer $DAYNIGHT_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"name":"Local project","repoUrl":"https://github.com/example/project.git"}' \
  "$DAYNIGHT_BASE_URL/api/v1/projects"
```

Copy the returned project's `id` into `PROJECT_ID`, then create and list tasks:

```bash
PROJECT_ID=YOUR_PROJECT_ID
curl --fail-with-body --header "Authorization: Bearer $DAYNIGHT_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"title":"Try the task dashboard","description":"Created locally"}' \
  "$DAYNIGHT_BASE_URL/api/v1/projects/$PROJECT_ID/tasks"
curl --fail-with-body --header "Authorization: Bearer $DAYNIGHT_TOKEN" \
  "$DAYNIGHT_BASE_URL/api/v1/projects/$PROJECT_ID/tasks"
```

Creation produces todo with version 1 and nullable execution endpoints. Creation
and metadata PATCH omit status. Status writes use only
`PUT /api/v1/projects/{projectId}/tasks/{taskId}/status` with exact positive int64
version and one of todo/in_progress/done. All nine pairs are supported. Version
is checked first; matching same-state preserves version/update time/timing,
actual change increments once. Entering active/done requires every direct
prerequisite done; reopening done refuses direct active/done dependents, including
external edges. Materials and unrelated fields remain unchanged.

Entering in_progress starts a new interval, return to todo clears both endpoints,
in-progress to done preserves a nullable start and writes the real end, and
todo to done records only an end. Migration 014 converts legacy proposed rows to
todo once, changing only their state/version/update time and preserving historical
timing and other fields. Default, data, CHECK and ledger change atomically.
Coordinate service/Web deployment and CLI upgrades; old action routes have no aliases.

Copy the created task ID into TASK_ID. With no intervening changes, the following
starts execution at version 1 and completes it at version 2. Both are real changes.

```bash
TASK_ID=YOUR_TASK_ID
curl --fail-with-body --request PUT --header "Authorization: Bearer $DAYNIGHT_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"version":1,"status":"in_progress"}' \
  "$DAYNIGHT_BASE_URL/api/v1/projects/$PROJECT_ID/tasks/$TASK_ID/status"
curl --fail-with-body --request PUT --header "Authorization: Bearer $DAYNIGHT_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"version":2,"status":"done"}' \
  "$DAYNIGHT_BASE_URL/api/v1/projects/$PROJECT_ID/tasks/$TASK_ID/status"
unset DAYNIGHT_TOKEN
```

If another member changes the task, fetch and review its current content and
state before deciding on the next action with that exact version. Stale versions
fail without applying the action. Do not automatically repeat a rejected or
uncertain write; read the task to reconcile an unknown outcome before making a
new explicit decision.

Refresh the dashboard to load the new data. Project registration stores
repository metadata without cloning or contacting the repository. A token uses
its owner's current project membership; removing a member or revoking the token
removes access on subsequent requests. See the
[server README](../../packages/daynight-server/README.md) for task updates,
dependency rules and the complete HTTP contract.

## Operate and update

The containers are named `daynight-postgres`, `daynight-gateway` and
`daynight-server`. These fixed names allow one localhost stack per Docker
daemon, including when a different Compose project name is selected.

Check health and follow logs:

```bash
docker compose ps
docker compose logs --follow
```

`/healthz` and `/readyz` are public database probes. They do not require a login
and do not call UniAuth; a ready server can still report a UniAuth login failure.
Both the gateway and server health checks use `/readyz`.

Use Compose to restart the stack:

```bash
docker compose restart
```

After updating frontend or server source, authentication or task-sync settings,
the gateway configuration or image, the published port, or network configuration,
run the startup command again to rebuild and recreate the stack together:

```bash
docker compose up --build --force-recreate --detach --wait --wait-timeout 120
```

The server shares the gateway's network namespace. A gateway restart outside
Compose, including an automatic container restart, can leave the server attached
to the old namespace and interrupt forwarding. Running the startup command
recreates the containers together and attaches the server to the current gateway
namespace while retaining the database and attachments.

If startup fails, inspect `docker compose ps --all` and `docker compose logs`.
Missing or invalid authentication settings stop the server with a configuration
error. After resolving the reported error, use the startup command again. Tests
use the separate [dev-ci deployment](../dev-ci/README.md); it creates isolated
resources without operating this stack.

## Persistence and backup

Two Compose-managed named volumes hold application data:

| Volume | Container path | Content |
|---|---|---|
| `postgres-data` | `/var/lib/postgresql` | PostgreSQL data, including users, sessions, project membership and attachment metadata |
| `attachment-data` | `/var/lib/daynight/storage` | Attachment bytes under `task-attachments/<projectId>/<taskId[:2]>/<taskId>/<relativePath>` |

Names are scoped to the Compose project. Server startup applies its embedded
migrations. Migration 015 gives each project a persistent `task_cache_epoch` UUID.
Normal task writes, stop, restart, `up --build --force-recreate`, and `down` preserve
the epoch and both volumes. Retain the private deployment configuration and the
corresponding UniAuth application registration separately from the application
data. Stop the stack and retain all application data:

```bash
docker compose down
```

To deliberately delete projects, tasks, authentication records, attachment
metadata and attachment files, remove both volumes:

```bash
docker compose down --volumes
```

The database and attachment directory form one backup pair. Retain the affected
projects' current epoch values from authenticated task-sync snapshots for restore
validation. Stop all server instances and direct database or file writers before
capturing both; keep writes stopped until both artifacts are complete. This makes
a normal backup stable but does
not repair a mismatch that already existed: file operations and PostgreSQL
metadata changes are not atomic. A database-only or directory-only restore does
not restore task attachments completely.

From `deployment/localhost/`, create a pair using the running stack's production
image for the archive. The temporary directory is local staging; retain the two
completed artifacts together in the operator's backup location. A failed command
leaves the server stopped so the failure can be diagnosed before writes resume.

```bash
(
  set -eu
  BACKUP_DIR="../../.tmp/daynight-backup-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$BACKUP_DIR"
  docker compose stop server
  docker compose exec -T postgres pg_dump --no-owner --no-acl \
    -U daynight -d daynight > "$BACKUP_DIR/postgres.sql"
  docker compose run --rm --no-deps -T --entrypoint tar server \
    -C /var/lib/daynight/storage -cpf - . > "$BACKUP_DIR/attachments.tar"
  docker compose up --no-build --detach --wait --wait-timeout 120
)
```

Restore a matching pair into fresh volumes using the corresponding application
image and the configured UniAuth application. The commands below deliberately
discard the current stack's application data. Set `BACKUP_DIR` to the retained
pair first; the files must be outside the volumes being removed. Stop all server
instances and direct database or file writers before restoration and keep them
stopped through epoch rotation. PostgreSQL and the gateway start before
restoration. After both SQL and files are restored, rotate `task_cache_epoch`
for every affected project before any server resumes. A dump restores saved
UUIDs, so restoring the old epoch does not identify a history replacement.
Archive extraction uses the normal UID/GID `10001:10001`, preserving the service's
ability to write.

```bash
(
  set -eu
  BACKUP_DIR=../../.tmp/daynight-backup-YYYYMMDDTHHMMSSZ
  test -s "$BACKUP_DIR/postgres.sql"
  test -s "$BACKUP_DIR/attachments.tar"
  docker compose down --volumes
  docker compose up --no-build --detach --wait --wait-timeout 120 postgres
  docker compose up --no-build --detach gateway
  docker compose exec -T postgres psql --set ON_ERROR_STOP=1 \
    -U daynight -d daynight < "$BACKUP_DIR/postgres.sql"
  docker compose run --rm --no-deps -T --entrypoint tar server \
    -C /var/lib/daynight/storage -xpf - < "$BACKUP_DIR/attachments.tar"
  docker compose exec -T postgres psql --set ON_ERROR_STOP=1 \
    -U daynight -d daynight \
    --command 'UPDATE projects SET task_cache_epoch = gen_random_uuid()'
  docker compose up --no-build --detach --wait --wait-timeout 120
)
```

The full-volume restore rotates all projects. For a supported selective import or
other history replacement, use the same stop/restore/rotate/start ordering and
restrict the `UPDATE` to the affected project IDs. Rotation changes only the UUID;
it does not edit task versions or timestamps. Keep database time valid and verify
imported task timestamps before resuming writes: an imported future timestamp can
keep a client's later watermark ahead of new task changes even after a full
snapshot, so UUID rotation alone does not correct that data.

After restore, sign in, confirm the affected project's epoch changed and a
request with its saved old epoch returns a complete task snapshot. Check project
membership, attachment lists, downloads and relative preview resources, and
upload a new file. This is a manual paired backup/restore procedure; it adds no
backup service or cross-store recovery mechanism. The
[deployment decision](../../.agents/notes/archived/architecture/2026-10-21-task-attachment-persistence.md)
owns the volume and validation rationale. The
[dev-ci attachment check](../dev-ci/README.md#attachment-persistence-check)
exercises this procedure with disposable data and confirms scoped cleanup.

## Attachment layout upgrade

Task attachment storage uses project directories, then the first two canonical
task UUID characters, then the complete task UUID. Public API/CLI paths and
relative preview resources remain task-relative. The old
`task-attachments/<taskId>/<relativePath>` layout requires the explicit offline
maintenance command; ordinary HTTP startup and requests do not move files or
select an old location.

Stop every server instance and all direct database/file writers for the entire
upgrade. Keep an independently tagged old image and a matching pre-migration
`pg_dump`/storage archive. The [normal backup](#persistence-and-backup) resumes
the stack after archival; for a layout upgrade, keep it stopped through planning,
application and verification. Maintenance uses only the database/root settings
and the image's normal UID/GID `10001:10001`; it does not need UniAuth to run.

From `deployment/localhost/`, capture the old image identity and backup pair,
then build the new server image without starting it:

```bash
(
  set -eu
  MIGRATION_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  MIGRATION_DIR="../../.tmp/daynight-attachment-layout-$MIGRATION_STAMP"
  mkdir -p "$MIGRATION_DIR"
  OLD_SERVER_IMAGE="$(docker inspect --format '{{.Image}}' "$(docker compose ps --all -q server)")"
  OLD_SERVER_TAG="daynight-attachment-layout-before:$MIGRATION_STAMP"
  docker image tag "$OLD_SERVER_IMAGE" "$OLD_SERVER_TAG"
  printf '%s\n' "$OLD_SERVER_TAG" > "$MIGRATION_DIR/old-server-image"
  docker compose stop server
  docker compose exec -T postgres pg_dump --no-owner --no-acl \
    -U daynight -d daynight > "$MIGRATION_DIR/postgres.sql"
  docker compose run --rm --no-deps -T --entrypoint tar server \
    -C /var/lib/daynight/storage -cpf - . > "$MIGRATION_DIR/attachments.tar"
  docker compose build server
  docker compose run --rm --no-deps -T server \
    migrate-attachment-layout plan > "$MIGRATION_DIR/plan.json"
  cat "$MIGRATION_DIR/plan.json"
  printf 'Migration artifacts: %s\n' "$MIGRATION_DIR"
)
```

The JSON summary supplies the operationId and storage-root-relative manifestPath.
An official `.attachment-layout-<operationId>/` directory appears only after the
manifest and initial planned state have both been prepared and synchronized in
`.attachment-plan-<operationId>/`, then promoted atomically. Plan preparation does
not move attachment bytes. Ordinary errors before promotion clean only their own
private attempt; a terminated process can leave an unpublished directory of plan
records, which does not block another plan and is not automatically swept.

If plan fails or terminates before an official operation is published, keep
writers stopped and rerun plan. If publication occurred but its success summary
was lost, the next plan reports `resume_required` with the official operationId;
use that ID for explicit continuation. Post-publication failures retain the full
initial record pair and require the same operation, even if no attachments have
yet moved. Do not remove an official operation to bypass this check.
Review the counts and any unregistered known-task files reported by the manifest.
Registered missing files, size or ownership mismatches, unknown task roots,
symlinks/special files and conflicts stop the operation; they are not repaired or
silently skipped. A genuinely empty store still yields a zero-count plan and
operation ID. Existing unfinished operations reject a new plan with
`category=resume_required` and their operationId. Existing completed operations
reject a new plan with `category=already_migrated` and their operationId; use
apply/resume with that same ID for verification. Do not remove a completed
operation to make plan run again: its record prevents reinterpreting the new
tree as legacy data, including zero-metadata project/task UUID collisions.
The server remains stopped after a failed command.

Set these values to the retained directory and the operationId from that plan:

```bash
(
  set -eu
  MIGRATION_DIR=../../.tmp/daynight-attachment-layout-YYYYMMDDTHHMMSSZ
  OPERATION_ID=UUID_FROM_PLAN
  docker compose run --rm --no-deps -T server \
    migrate-attachment-layout apply --operation-id "$OPERATION_ID" \
    > "$MIGRATION_DIR/receipt.json"
  cat "$MIGRATION_DIR/receipt.json"
)
```

Only a successful `phase=complete` result means the new bucket passed content and
fresh-snapshot metadata verification. The command first stages the old bucket,
then moves whole task subtrees and finally publishes the verified target. It
preserves all business rows and task_cache_epoch. The database advisory lock
only serializes maintenance commands; operator-established quiescence is still
required. The three full hash passes and backup read determine the stopped-write
window, so estimate it from actual bytes and storage throughput.

Once the official operation exists, a stopped process or failed move requires
its existing ID. Retain the operation directory and staged data, keep writers
stopped and resume rather than issuing another plan:

```bash
docker compose run --rm --no-deps -T server \
  migrate-attachment-layout resume --operation-id OPERATION_UUID
```

Resume accepts only positions and contents explained by that manifest. An old
bucket already moved to source is not an empty installation. Publication before
the completion receipt can be verified and completed; the same completed
operation can be verified again without moving files. Conflicting or unexplained
states remain failures. Source symlinks are rejected by maintenance even though
the generic local adapter retains its existing root-confined symlink behavior.

After the command succeeds, start the new image while business clients and other
writers remain paused:

```bash
docker compose up --no-build --detach --wait --wait-timeout 120
```

Check the original attachment lists, downloads and relative previews, including
HTML/Markdown resources, before resuming those writers. Archive the manifest,
completion receipt, JSON diagnostics and backup pair with the old image tag.

For rollback, keep writers stopped and use the matching pre-migration SQL/file
pair plus the retained old server image in the [fresh-volume restore](#persistence-and-backup)
procedure. Restoring historical content is distinct from layout migration:
rotate affected task_cache_epoch values where that schema supports task-sync
before reopening its server. A retained version that predates task-cache epochs
must use its matching schema and restore procedure, not current-version SQL.
Before new writes resume, this restores the captured state. After writers resume,
restoring that backup would discard subsequent changes and requires a separate
data-preservation decision. Maintenance is not a backup system or general
filesystem/PG reconciliation service.

## Exposure

The authenticated dashboard and API are published only on host `127.0.0.1`.
PostgreSQL has no published host port. The stack uses fixed development-only
database credentials (`daynight` / `daynight-local`, database `daynight`). The
gateway forwards TCP to the server's strict `127.0.0.1:8787` listener inside
their shared container network namespace, preserving the server's HTTP handling.
TLS termination for an HTTPS public origin belongs to the deployment's external
proxy.

UniAuth login, Daynight browser sessions and personal access tokens use the
[authentication requirements](../../docs/spec/daynight-auth.md) and
[architecture](../../docs/design/daynight-auth.md). Project authorization covers
tasks, graphs, attachment downloads and previews. Trusted same-origin executable
HTML previews retain their iframe, relative-resource and keyboard behavior;
their scripts execute with the signed-in user's same-origin authority. There is
no separate preview domain.

The review CLI has its own
[review configuration and startup](../../README.md#review-configuration-and-startup).
