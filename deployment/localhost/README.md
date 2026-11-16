# Localhost deployment

This Docker Compose stack builds and runs the authenticated task dashboard,
project/task HTTP API, PostgreSQL and temporary Redis monitoring storage together.
Docker Engine 28 or newer, Linux containers and Docker Compose 2.20 or newer
are required. Linux hosts and macOS
with Docker Desktop using Linux containers can run this stack. The first build
accesses Docker Hub, the npm registry, the Go module registry and Debian package
repositories. No host Go,
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
| `DAYNIGHT_REDIS_URL` | Server connection URL for monitoring; the template uses `redis://redis:6379/0` on the Compose network |
| `DAYNIGHT_REDIS_MAXMEMORY` | Positive Redis memory budget, such as the template's `128mb` |

Compose passes `--root /var/lib/daynight` and mounts `config/` read-only at
`/var/lib/daynight/config`. The public `config.yml` supplies the listener,
metrics, development database URL and storage path. It contains
only development values; keep credentials in the private `.env` file. The
server loads `config.yml`, then optional `config.local.yml`, then explicitly
set environment variables. Restart the server after changing files. Keep the
public directory at mode `0755` and its file at `0644` so UID 10001 can read
them. Protect any local override and do not commit secrets.
Optional `DAYNIGHT_S2S_SHARED_KEY` enables trusted application issuance when set
to 32–256 visible ASCII bytes; its empty template value disables issuance.
`DAYNIGHT_S2S_ALLOWED_ORIGIN` separately enables exact application browser CORS
and user WebSocket Origin admission. Keep the key private. Both optional Compose
entries preserve absence, explicit empty and nonempty values: absence from the
host and private `.env` retains YAML, empty overrides YAML with the disabled
value, and nonempty overrides it. The host environment takes precedence over
`.env`. Restart after changing either setting; replacing the key does not revoke
existing application grants. The [authentication contract](../../docs/spec/daynight-auth.md#用户应用授权-api)
owns issuance, refresh and revocation behavior.

Required authentication environment bindings remain mandatory even when a
local YAML override is present. The image sets the three image tool paths and
the root-relative staging path `storage/.image-validation` through environment
variables.

Redis uses `noeviction`: when the budget is exhausted, monitoring writes fail
instead of silently evicting current states. Size the budget for the deployment's
actual workload and Redis overhead; the template does not guarantee capacity for
an arbitrary number of accounts. An invalid Redis setting causes a visible
configuration or Redis startup error. The URL must address the intended Redis
instance from the server's network namespace.

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
invoked with its path. It builds the frontend with Node.js 24 and pnpm 11.28.6.
The production TypeScript configuration checks application sources and the Vite
configuration; tests and acceptance tooling use the separate full-workspace
`pnpm web:typecheck` command. The image includes the CLI source tree required by
shared protocols and their transitive imports. The script embeds generated assets
in the Go 1.27.2 binary, recreates the service containers while preserving the
PostgreSQL, attachment and server log volumes, and waits up to 120 seconds for
their health checks. Redis is required to start but has no health gate on Server. Build time
is separate from that readiness timeout. The final nonroot runtime image contains
the server binary, Node.js 24, Debian's system CA certificates and the
lockfile-selected sharp dependency closure. Go uses the system trust store to
verify outbound HTTPS connections, including the UniAuth gateway.
The pinned image-validation helper and its build manifest live under
`/opt/daynight/image-validation`; service validation runs independently from
Controller validation. Provider image profiles remain disabled until their full
native evidence exists. It prepares the required writable
`/var/lib/daynight/storage` for UID/GID `10001:10001`. The Compose-managed
`attachment-data` volume mounts there. The `server-logs` volume mounts at
`/var/lib/daynight/logs`. Docker initializes fresh volumes from the image
directories with their ownership, so the server writes as UID 10001 without a
privileged startup process.

If `storage.root` is changed, update the attachment volume mount and the fixed
storage paths in the backup and restore commands below to match it before use.

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

The stack also exposes Prometheus metrics at
`http://127.0.0.1:8788/metrics`. Set `DAYNIGHT_METRICS_PORT` in `.env` to
change this host port; it must differ from `DAYNIGHT_PORT`. The gateway forwards
metrics over a separate TCP stream to the server's loopback metrics listener.
Both published ports bind host loopback only. The metrics endpoint has no
application authentication; protect access to the host and its network
namespace. The business port does not expose `/metrics`. See the
[server metrics configuration](../../packages/daynight-server/README.md#metrics)
for the endpoint and collector behavior.

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

Set `DAYNIGHT_BASE_URL` to the configured public origin and read the current
user. Copy its `id` into `DAYNIGHT_USER_ID`, then create a project in Personal:

```bash
DAYNIGHT_BASE_URL=http://127.0.0.1:8787
curl --fail-with-body --header "Authorization: Bearer $DAYNIGHT_TOKEN" \
  "$DAYNIGHT_BASE_URL/api/v1/me"
DAYNIGHT_USER_ID=YOUR_USER_ID
curl --fail-with-body --header "Authorization: Bearer $DAYNIGHT_TOKEN" \
  --header 'Content-Type: application/json' \
  --data "{\"name\":\"Local project\",\"repoUrl\":\"https://github.com/example/project.git\",\"expectedUserId\":\"$DAYNIGHT_USER_ID\"}" \
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

The containers are named `daynight-postgres`, `daynight-gateway`,
`daynight-server` and `daynight-redis`. These fixed names allow one localhost
stack per Docker daemon, including when a different Compose project name is selected.

Check health and follow logs:

```bash
docker compose ps
docker compose logs --follow
```

Server JSON logs also append to `server-logs` as `daynight-server.log`, with up
to ten numbered rotated files. Each normal server needs its own log volume;
the log writer holds an exclusive lock for the process lifetime. The `run_id`
field associates configuration and logging diagnostics with one server start.
Logs are separate from the database and attachment backup pair.

`/healthz` and `/readyz` are public database probes. They do not require a login
and do not call UniAuth; a ready server can still report a UniAuth login failure.
Both the gateway and server health checks use `/readyz`.
Redis does not participate in `/readyz`, and stopping or restarting Redis does
not restart Server. Monitoring requests return `503` when Redis is unavailable;
capacity rejection returns `503` for writes. PostgreSQL-backed business operations
continue independently.
Each accepted current Worker state expires after one hour; reads and duplicate
writes do not renew it. Redis has no persistent volume and RDB and AOF are
disabled. Recreating or restarting Redis loses its states; Workers with monitoring
reporting subsequently collect and submit their current state, without replaying
history. Redis data is excluded from the database and attachment backup pair.

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
| `postgres-data` | `/var/lib/postgresql` | PostgreSQL data, including users, sessions, project membership, attachment metadata and Session archive metadata/receipts |
| `attachment-data` | `/var/lib/daynight/storage` | Attachment bytes under `task-attachments/<projectId>/<taskId[:2]>/<taskId>/<relativePath>` and new Session archive bodies under the project/user and Session UUID shards described in the [Session design](../../docs/design/task-session-protocol.md#服务端归档布局) |

Names are scoped to the Compose project. Server startup applies its embedded
migrations. Before upgrading to the login scope schema, stop old servers from
starting new logins while allowing existing callbacks to complete, or wait for
pending logins to expire (10 minutes). The migration fails without deleting
valid pending transactions; retry after they are consumed or expired. Do not run
old login writers after migration. Migration 015 gives each project a persistent `task_cache_epoch` UUID.
Normal task writes, stop, restart, `up --build --force-recreate`, and `down` preserve
the epoch and both data volumes. Retain the private deployment configuration and the
corresponding UniAuth application registration separately from the application data.

Before upgrading across GitHub synchronization migration 073, stop and drain all
old server replicas and replace every replica with the new version before starting
service. Startup applies the migration before accepting requests. Do not mix old
and new servers: old code ignores the Project synchronization setting. Existing
Projects retain their connection, PRs and history but synchronization defaults to
off; an administrator must enable it again. See the [server upgrade guidance](../../packages/daynight-server/README.md).

Stop the stack and retain all application data:

```bash
docker compose down
```

To deliberately delete projects, tasks, authentication records, attachment
metadata/files, Session archive metadata/bodies and the server logs, remove the
volumes:

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

## Exposure

The authenticated dashboard and API are published only on host `127.0.0.1`.
PostgreSQL and Redis have no published host port. The stack uses fixed
development-only database credentials (`daynight` / `daynight-local`, database `daynight`). The
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
