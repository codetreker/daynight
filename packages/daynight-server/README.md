# daynight-server

The Go service owns PostgreSQL-backed project and task management. Its runtime
foundation is implemented: explicit database and file-storage configuration,
loopback-only HTTP binding, connection validation, structured request logs, cancellation, and bounded
HTTP shutdown. Versioned migrations and transactional storage are implemented;
project/task APIs and built-process acceptance are implemented. The current
executable serves project, task and complete task-graph routes together with the
embedded task dashboard. Generic bucket/path local storage, task attachment
metadata and file/preview HTTP endpoints are implemented. Dependency rows also
persist an ordinary/external classification and task/graph reads expose the
required external subset. Public create and versioned PATCH accept explicit
classification while preserving all-edge execution and project authorization.

The [requirements](../../docs/spec/daynight-server.md) own observable behavior and
the [design](../../docs/design/daynight-server.md) owns architecture and concurrency.
The TypeScript review command retains its separate configuration, storage and
lifecycle. The client HTTP foundation targets this service's API.

The [authentication requirements](../../docs/spec/daynight-auth.md) and
[architecture](../../docs/design/daynight-auth.md) define UniAuth identity
handoff, local users, browser sessions, personal access tokens and project
membership. The [identity foundation](../../.agents/notes/implemented/architecture/2026-10-22-identity-credentials.md)
implements persistent users, browser-bound login transactions, sessions, PATs and
callable HTTP handlers. NewIdentity/NewAuthentication/RegisterRoutes are composed by the runtime. The [membership foundation](../../.agents/notes/implemented/architecture/2026-10-22-project-membership.md)
adds NewMemberships/NewMembershipRoutes, transaction-scoped access checks, private
project creation, filtered project lists, administrator changes and invitations.
The project settings API provides a versioned execution-warning threshold that
administrators save and members read.
The application mux mounts all of these modules and requires authentication for
every project, task, graph and attachment route. The production dashboard mounts
`AuthenticatedApp`; the CLI uses user PATs. Existing projects are assigned members
manually and remain inaccessible while they have no members. Trusted executable
HTML retains its application origin, relative resources and keyboard behavior.
The [activation decision](../../.agents/notes/implemented/architecture/2026-10-22-authentication-activation.md)
owns composition and credential-private validation; current delivery results
require receipts bound to the tested source.

## Layout

| Path | Responsibility |
|---|---|
| `cmd/daynight-server/` | Environment, process signals, dependency assembly, exit status |
| `internal/server/` | API/UI routing, HTTP lifecycle, request context, request IDs, structured logs |
| `internal/webui/` | Embedded production HTML/assets and static response policy |
| `internal/core/store/` | PostgreSQL migrations, transactions, scoped writes and consistent reads |
| `internal/filestorage/` | Generic bucket/path byte operations and address validation |
| `internal/filestorage/local/` | Root-confined local files, complete-file replacement and root lifecycle |
| `api/` | Project/task/attachment, identity and membership DTOs; common HTTP error envelopes |
| `internal/service/` | Project/task use cases, identity/credentials, project membership/invitations, state/version policy and scoped cursors |
| `internal/core/` | Shared project/task, identity/member models and resource-not-found markers |

HTTP startup prepares one local file-storage root and creates and verifies one
concrete PostgreSQL store. The handler factory `server.New(Dependencies, Config, logger)` returns
`(http.Handler, error)`, validating mandatory authentication configuration before
assembling the mux. `Dependencies` supplies `Store` and `Files` before the listener
accepts requests. The composition
root assembles services without opening another pool or file root. The runtime
owns HTTP shutdown, storage closure and pool closure. Startup applies the embedded migrations before accepting requests.
One pinned connection holds a session advisory lock across version checks and all
migration transactions; unknown versions, gaps and checksum mismatches stop startup.

## Local Docker deployment

Configure the required UniAuth App and origin settings using the
[deployment guide](../../deployment/localhost/README.md), then run
`bash deployment/localhost/up.sh` from the repository root to build and start the
dashboard and API with PostgreSQL and wait for readiness. Only Docker is required
on the host; valid authentication settings remain mandatory. The [deployment guide](../../deployment/localhost/README.md) owns
prerequisites, API examples, port selection and persistence/teardown commands.
The gateway publishes host `127.0.0.1:8787` and forwards TCP to the server's
loopback listener in their shared network namespace; the database has no
published host port. Startup uses this module's embedded migrations. Open
`http://127.0.0.1:8787/` for projects and task graphs. The
[dev-ci deployment](../../deployment/dev-ci/README.md) reuses the production
Dockerfile and gateway in a unique disposable project for tests.

## Build and run

Go **1.27.2** and `pgx/v5` **5.11.0** are pinned. Source builds also require
Node.js 24 and pnpm 11.28.6 to build the embedded UI. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm web:build
cd packages/daynight-server
source scripts/env.sh
go build -o .tmp/daynight-server ./cmd/daynight-server
export DAYNIGHT_DATABASE_URL='postgres://daynight:password@127.0.0.1:5432/daynight?sslmode=disable'
export DAYNIGHT_STORAGE_ROOT="$PWD/.tmp/storage"
export DAYNIGHT_PUBLIC_ORIGIN='http://127.0.0.1:8787'
export DAYNIGHT_UNIAUTH_URL='https://identity.example.com'
export DAYNIGHT_UNIAUTH_APP_ID='<registered-app-id>'
export DAYNIGHT_UNIAUTH_APP_SECRET='<server-side-app-secret>'
export DAYNIGHT_UNIAUTH_CALLBACK_URL='http://127.0.0.1:8787/api/v1/auth/callback'
export DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN=1
.tmp/daynight-server
```

`web:build` typechecks and builds the web package, validates the real output and
publishes it to `internal/webui/dist/`. Generated files are ignored by Git; a
clean Go build without them fails at `go:embed`. No placeholder index or frontend
runtime is used. Once built, the binary requires PostgreSQL and a writable,
local storage directory and valid UniAuth App settings at runtime. Linux requires
case-sensitive storage. Native macOS development also accepts an ordinary
case-insensitive directory, without mounting an image. Names that alias existing
directory entries are refused rather than overwriting another attachment;
coexistence of differently cased names is covered by Linux tests and the optional
APFS acceptance channel.
The example explicitly enables a controlled local HTTP origin. Production uses
HTTPS and leaves that exception disabled. Register the exact callback URL with
UniAuth and supply real credentials through private environment configuration;
never commit them. The [deployment guide](../../deployment/localhost/README.md)
owns the shared authentication setup.

Use credentials suitable for the local PostgreSQL instance. The process validates
the connection before listening and exits nonzero on startup or shutdown failure.
It never logs the database URL, driver error text, SQL, request body, or query
string. Errors retain their original causes internally; logs expose safe
diagnostics and cause categories.

| Environment variable | Meaning | Default |
|---|---|---|
| `DAYNIGHT_DATABASE_URL` | Explicit PostgreSQL connection string | Required |
| `DAYNIGHT_STORAGE_ROOT` | Writable local storage directory; case-sensitive on Linux, ordinary directories supported for native macOS development | Required |
| `DAYNIGHT_PUBLIC_ORIGIN` | Exact main-site origin, HTTPS in production | Required |
| `DAYNIGHT_UNIAUTH_URL` | UniAuth gateway origin | Required |
| `DAYNIGHT_UNIAUTH_APP_ID` | Registered UniAuth backend App ID | Required |
| `DAYNIGHT_UNIAUTH_APP_SECRET` | Server-only UniAuth App secret | Required |
| `DAYNIGHT_UNIAUTH_CALLBACK_URL` | Exact same-origin callback URL with a canonical non-root path and no query/fragment | Required |
| `DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN` | Explicit main-site HTTP test-origin policy (`0` or `1`) | `0` |
| `DAYNIGHT_ALLOW_LOOPBACK_HTTP` | Separate SDK permission for a literal loopback UniAuth HTTP gateway (`0` or `1`) | `0` |
| `DAYNIGHT_LISTEN_ADDR` | Numeric loopback IP and port, including IPv6 syntax | `127.0.0.1:8787` |
| `DAYNIGHT_STARTUP_TIMEOUT` | Positive Go duration for database connection and listener startup | `10s` |
| `DAYNIGHT_SHUTDOWN_TIMEOUT` | Positive Go duration for draining HTTP requests | `10s` |

Wildcard, non-loopback, hostname, scoped IPv6, and malformed listen addresses are
rejected. Callback paths that collide with application routes and login return
loops are rejected before a login transaction is created. Only the configured
callback path is routed; there is no fixed-path alias or authentication-disable
mode. The two HTTP exceptions control different origins and do not imply each
other. `/healthz` and `/readyz` are public GET/HEAD endpoints; readiness checks
only PostgreSQL, so it does not establish UniAuth connectivity or login success.
Port `0` requests an ephemeral loopback port; the bound address appears
in the startup log. Invalid timeout values fail validation.

`SIGINT` and `SIGTERM` stop accepting connections and begin draining requests.
Active request contexts remain usable during the drain. On deadline, the runtime
cancels remaining request contexts, force-closes HTTP connections, and closes the
file-storage root and database pool after request-owned resources are released.
Database operations must use the request context and release acquired connections.
The runtime also closes an acquired file root on later startup failure. Local
files remain on disk when the handle closes. Startup fixtures supply isolated
roots; built-process restart tests reuse their fixture root.

Logs use JSON `slog` records with type, component, phase, and request ID. HTTP
records include method, route template, status, and duration. A supplied
`X-Request-ID` must contain 1–64 ASCII letters/digits with optional `.`, `_`, or
`-` after the first character; invalid or absent values receive a generated ID.
The response returns `X-Request-ID`. An unmatched route has an empty route template.
UI and API requests use the same logging wrapper. Exact `/`,
`/projects/{projectId}`, `/projects/{projectId}/members`,
`/projects/{projectId}/settings`, `/projects/{projectId}/tasks/{taskId}` and
`/projects/{projectId}/tasks/{taskId}/attachments/{path...}` page shapes return
the index. The task routes open complete standalone details, with the attachment
path selecting its file and defaulting to the Attachments tab. Invalid page
IDs retain the existing index response and frontend not-found behavior. The
raw attachment path guard also protects this page namespace before ServeMux
normalization, rejecting invalid segments without redirecting or repairing the
address. Task, graph and file reads use the existing scoped APIs; no new
metadata, authorization or storage format is introduced. The
[detail design](../../docs/design/daynight-task-inspection.md#独立完整任务详情) owns
the complete page, and the
[attachment design](../../docs/design/daynight-task-attachments.md#独立附件阅读页)
owns file rendering. Unknown page shapes return JSON 404; `/assets/` serves actual generated
files without directory listings or an HTML fallback. Unknown API routes retain
JSON 404 responses. GET routes support HEAD; other methods receive 405 with
`Allow`. HTML, complete graphs and latest task details use
`Cache-Control: no-store`; hashed assets use long-lived immutable caching.
Handler panics emit a safe request-correlated error and abort the HTTP request;
the recovered value and stack are not printed by the HTTP server.

## Validate

Install the root workspace dependencies with `pnpm install --frozen-lockfile`
before validation. Tests require a real PostgreSQL database and fail when it is
unavailable or
`DAYNIGHT_TEST_DATABASE_URL` is missing. For a disposable local instance, use the
same PostgreSQL **18.6-bookworm** image as CI:

```bash
docker run --detach --name daynight-server-tests \
  --env POSTGRES_USER=daynight --env POSTGRES_PASSWORD=daynight-test \
  --env POSTGRES_DB=daynight --publish 127.0.0.1::5432 postgres:18.6-bookworm
docker port daynight-server-tests 5432
docker exec daynight-server-tests pg_isready -U daynight -d daynight
```

Set the reported loopback port in the test URL, then run:

```bash
export DAYNIGHT_TEST_DATABASE_URL='postgres://daynight:daynight-test@127.0.0.1:PORT/daynight?sslmode=disable'
bash scripts/check.sh
docker rm --force --volumes daynight-server-tests
```

The check first runs the shared root `pnpm web:build`, then builds the executable,
runs `go vet`, prepares the pinned real-UniAuth integration fixture, and expires project-local Go test
results so database changes cannot be hidden by cached coverage, and executes race-enabled package
tests through `go-cov` pinned to commit
`d6caf2759e330b48d69a543695e37002a48feb1d`. The checked-in `.go-cov.toml`
requires at least 85% coverage per package and 80% per function, with critical
blocks enforced and no production exclusions. A separate exact calculation over
the raw coverage profile requires overall statement coverage **strictly greater
than 90%**. Exactly 90% fails. The check also tests that calculation's boundary
and malformed-profile behavior.

`scripts/env.sh` places downloaded tools, dependencies, caches, binaries, and
temporary outputs under this module's `.tmp/`. Both Go-consuming CI jobs restore
module and compiler caches using `go.sum`; `go clean -testcache` still invalidates
server test results before validation so database and coverage observations run
again. Both local validation and CI use
`scripts/check.sh` and the same coverage configuration. The tests cover real
database connection/query cancellation, HTTP cancellation, graceful and forced
drain, listener/pool reuse, process configuration/exit status, and log redaction.

Authentication integration prepares the exact UniAuth gateway source at
`0978963813fcefd9d553f6cb9bcc319084c764b3` with
`scripts/prepare-uniauth-fixture.mts`, using Git/module registry access. Its checked-in
`testdata/uniauth-fixture` command is built inside that source module; the real
gateway, App registry and GitHub adapter run on loopback, with only external
provider HTTP responses controlled. Private App credentials cross a task-local
0600 IPC file and are removed after reading. Built-process, installed-CLI, browser
and budget fixtures obtain normal Daynight sessions and PATs through this gateway;
private fixture metadata stays outside public receipts and artifact trees. The fixture process, SQLite files,
checkout and executable remain under the module `.tmp/`; tests close their own
process and file resources. No application module replacement or global tool
installation is required. For focused authentication integration tests after
`scripts/env.sh`, keep `DAYNIGHT_TEST_DATABASE_URL` set and prepare the fixture:

```bash
DAYNIGHT_TEST_UNIAUTH_FIXTURE="$(node scripts/prepare-uniauth-fixture.mts)"
export DAYNIGHT_TEST_UNIAUTH_FIXTURE
```

The full check performs this preparation automatically. The real wire-loss test in
[`auth_transport_acceptance_test.go`](internal/server/auth_transport_acceptance_test.go)
consumes a successful upstream result, closes the actual SDK-side TCP connection,
and verifies upstream 410, callback replay 401, zero failed-login sessions and
fresh-login recovery. Product, proxy and gateway cleanup is part of the test.
The [combined authentication decision](../../.agents/notes/implemented/testing/2026-10-23-authentication-combined-acceptance.md)
owns that proof and the separate native/container browser-plus-installed-CLI
journeys. Focused results retain their recorded source scope; controlled-provider
proof is separate from an actual upstream human login.

## File storage

`filestorage.Storage` exposes `Put`, `Open` and `Delete` using bucket and real
relative path. LocalStorage mirrors `<root>/<bucket>/<path>` and validates
addresses before resolving them through `os.Root`. It rejects roots that cannot
distinguish case and rejects object access outside the root. `Open` returns the
size of its opened handle. Callers own the returned body and input reader.

Writes stream through an owned temporary file and publish complete contents.
An empty internal directory can be reused as a file path; existing child files
remain conflicts. Internal namespace synchronization belongs to this storage
instance and does not coordinate filesystem operations with PostgreSQL or with
other processes sharing a root. The accepted non-atomicity issue is owned by the
[attachment requirements](../../docs/spec/daynight-task-attachments.md).

Both Compose deployments mount a project-scoped `attachment-data` volume at
`DAYNIGHT_STORAGE_ROOT=/var/lib/daynight/storage`. Fresh-volume initialization
preserves the image directory's UID/GID `10001:10001`, and the normal nonroot
server writes without a privileged startup process. Normal restart and rebuild
retain PostgreSQL metadata and attachment bytes; dev-ci removes both owned data
volumes on cleanup. The [deployment guide](../../deployment/localhost/README.md#persistence-and-backup)
owns retention and the stopped-write, paired PostgreSQL/directory backup and
restore commands. A matching pair preserves the state captured; it does not
repair a pre-existing cross-store mismatch. Browser management and CLI commands
remain separate from the backend file API below.

The [real-container attachment check](../../deployment/dev-ci/README.md#attachment-persistence-check)
verifies nonroot volume writes, nested original bytes and previews, restart and
full recreation, two-project isolation, targeted cleanup and fresh-volume paired
restore followed by another upload.

## Task attachment API

For `T=/api/v1/projects/{projectId}/tasks/{taskId}`, the service provides:

| Method and path | Behavior |
|---|---|
| `GET T/attachments` | Metadata page, using existing limit/cursor and items/nextCursor |
| `PUT T/attachments/files/{path...}` | Raw single-file creation (201) or overwrite (200) |
| `GET T/attachments/files/{path...}` | Original bytes with download disposition |
| `DELETE T/attachments/files/{path...}` | Delete one registered file (204), missing record 404 |
| `GET T/preview/{path...}` | Inline same-origin content and relative resources |

Log in through the Web workspace, create a PAT and save it using the hidden
`daynight setup` prompt or its explicit stdin option. With the configured service
and existing project/task IDs, upload a local document:

```bash
daynight task attachment put TASK_ID ./design.md --project PROJECT_ID --path docs/design.md
```

The path is relative to the task, preserves case, and each URL segment is encoded
individually. No request uploads or replaces a directory. A missing content type
means `application/octet-stream`; invalid types are rejected. Binary uploads do
not use the existing 1 MiB JSON decoder.

Metadata is stored in `task_attachments`, keyed by task and path with C collation;
the storage address is `task-attachments/<taskId>/<path>`. List cursors bind the
project, task and list type and page by path, with no cross-page snapshot.
Attachment operations leave task fields, properties, version and timestamps
unchanged. Path conflicts return `409 path_conflict`; missing scoped records
return 404. An existing record with missing disk contents remains a storage
error. Filesystem and PG changes remain non-atomic as the documented known issue.

Content-Length comes from the opened file, not cached metadata. HEAD returns
headers without reading the body. Mutable responses use no-store. Before a
stream begins, failures use the existing JSON error envelope; after commitment,
the server logs one correlated error and aborts the transfer without a JSON
suffix. Trusted HTML preview runs with the application origin permissions.
Relative CSS, scripts, images and data URLs resolve under the fixed preview
path; ordinary query parameters do not change the file name. The
[authentication architecture](../../docs/design/daynight-auth.md) requires a fresh
session/PAT check at HTTP admission and project membership in the pre-I/O
snapshot. An admitted file operation may finish; membership is not rechecked
after file I/O. These checks retain trusted same-origin execution, existing
preview routes and K1 filesystem/PostgreSQL non-atomicity.

## PostgreSQL storage boundaries

`Store.WriteProject` locks one project in a `READ COMMITTED` transaction before
calling the supplied operation. Resource services require an explicit principal
and check membership after acquiring this lock; administrator actions also
require the admin role. Credential validation occurs at HTTP admission and is
not repeated inside the business transaction. The operation receives a project-scoped
`ProjectTx`; its subsequent reads observe commits made while it waited for the
lock. Returning an error rolls back fields, properties, dependencies, version and
timestamps together. Only expose a captured resource after the outer call
succeeds.

`Store.ReadSnapshot` uses read-only `REPEATABLE READ` for project/task queries and
derived readiness, with membership and resource reads in the same snapshot.
Project-list membership filtering precedes pagination. Pages use a validated limit and optional `(createdAt, id)`
position; status/readiness filters run before keyset pagination. Page lookahead
is returned as `HasMore`; HTTP cursor encoding belongs to the API layer.

The shared `core.Project` and `core.Task` models have one representation across
storage and service. Store queries report prerequisite/dependent records and
candidate reachability. The typed property codec in `internal/taskproperties/`
stores serialized JSON in `tasks.properties` text, allowing JSON-escaped NUL
without PostgreSQL JSONB restrictions. Migration `003_task_properties.sql` gives
existing tasks empty PR lists while preserving version and timestamps. Migration
015_task_worker.sql inserts explicit worker:null into the canonical stored text
and updates the default without JSON/JSONB conversion, preserving opaque PR
strings and task metadata. The stored/read codec is distinct from public writable
properties, which reject worker even when null or unchanged. Corrupt stored
structures fail reads; there is no read-time default. The HTTP boundary
and property codec share the strict object decoder in `internal/jsonobject/`.
The service owns reference validation, DAG/state rules, optimistic version
comparison and semantic no-ops. There are no foreign keys or
delete operations. Direct database writers must not bypass these service rules.

Store tests use unique owned schemas and real PostgreSQL sessions. They prove
old-schema property migration with unchanged metadata, multi-migration exclusion,
rollback after partial writes, snapshot consistency, project-lock serialization,
independent projects and cancellation. Rollback and
advisory unlock use independent bounded contexts and preserve original causes.

## Project API

| Method | Path | Result |
|---|---|---|
| `POST` | `/api/v1/projects` | `201`, project and `Location` |
| `GET` | `/api/v1/projects` | `200`, project page |
| `GET` | `/api/v1/projects/{projectId}` | `200`, project |
| `PATCH` | `/api/v1/projects/{projectId}/settings` | `200`, full project with saved settings |

Creation accepts `name` and `repoUrl` and atomically makes its caller the first
project administrator. Lists contain only the caller's member projects.
Names preserve accepted text and must be nonempty UTF-8 without NUL. Repository addresses accept HTTPS, SSH URL and SCP
syntax, including SSH aliases and `@` inside repository paths. HTTPS userinfo,
SSH passwords, controls, query and fragment are refused. Credential-like
ambiguous SCP forms are rejected; use explicit SSH URL syntax when needed.
Registration performs no network, Git, clone or CLI-configuration operations.
Different projects can reference the same repository. UUID IDs are canonicalized
to hyphenated lowercase; project repository metadata has no update/delete API.

Every Project resource, including list items and the project embedded in task
graphs, includes `settings: {version, executionWarningMinutes}`. Migration
`010_project_settings.sql` gives new and historical projects an explicit settings
version of `1` and warning threshold of `60` minutes, preserving historical
creation/update timestamps and task timing. Settings live on the project row;
no read-time default or separate settings table is involved.

Members can read the saved settings. Only a current project administrator can
PATCH them, using exactly `version` (a positive int64 JSON integer) and
`executionWarningMinutes` (an integer from `1` through `2147483647`). Query
parameters and the bare query marker are rejected. Strict body parsing rejects
missing, duplicate, unknown, null, fractional, exponent and out-of-range fields.
The existing Cookie Origin and PAT authentication rules apply. Successful
responses return the complete saved Project and `Cache-Control: no-store`.

The settings service acquires the project lock, rechecks current membership and
administrator role, compares the exact settings version, then handles a same-value
no-op or change. A stale same-value request returns `version_conflict`; a current
same-value request preserves the complete resource. A real change increments
only the settings version and records the project update time using the post-lock
SQL statement timestamp. It leaves task timestamps and other projects unchanged.
Permission changes during a lock wait take effect before saving. Cancellation,
rollback and transaction-completion errors cannot be reported as a saved value
or hidden behind a pending domain refusal.

Creation requires `application/json` (optionally UTF-8 charset), one object within
1 MiB, exact field names and unique keys. Unknown/read-only fields, null required
fields, wrong types, invalid UTF-8 and trailing JSON return `invalid_input`.

Lists accept `limit` (default 50 only when absent, range 1–100) and opaque
`cursor`. Empty, repeated, malformed and unknown query parameters fail. Cursors
bind a version, list kind, project/filter scope and exact `(createdAt, id)`
position. Responses contain `items: []` for empty lists and `nextCursor: null`
on the final page. Individual reads use one snapshot; pagination does not retain
a cross-request snapshot.

Errors use `{"error":{"code":"not_found","message":"...","requestId":"..."}}`:
input 400, missing/invalid credentials 401, insufficient administrator role or
invalid Cookie-write Origin 403, missing or inaccessible resource 404,
unsupported method 405 with `Allow`, stale settings version 409, and internal failure 500.
Responses and logs do not echo submitted URLs, bodies, SQL or driver messages.
The request ID matches `X-Request-ID`; parsed resource operations log the
canonical project ID. Database/transaction completion failures take precedence
over a pending missing-resource result. Already-cancelled requests do not write
a response.

## Task service

`service.NewTasks` exposes create/read/update and `SetStatus` over the same
concrete store. `SetStatus` receives context, principal, project/task IDs and a
version/status input. Every project member can write tasks; administrator role
additionally manages members, invitations and project settings. Status PUT and
method-refusal handlers authenticate, require exact Cookie Origin and use no-store.

Creation uses todo, version 1, nullable execution endpoints, allowAgents=false
and unrestricted requiredPlatform=null unless explicitly supplied.
It rejects caller-supplied status, timing and permission; platform creation accepts
null or windows/linux/macos. PATCH retains field presence separately from nullable value. Properties/PRs and both
dependency collections have explicit empty defaults. Updates require a positive
expected int64 version and at least one mutable field; omitted pointers preserve
values, while empty description/dependency/PR lists clear them. Only requiredPlatform accepts null to clear; other JSON null input is rejected.
Dependencies are canonical sorted UUIDs, checked for duplicate identity,
self-reference, missing/cross-project tasks and cycles. Active/done metadata
candidates require all predecessors done; todo may have unfinished predecessors.

Ordinary tasks without active/released worker ownership accept all nine pairs
across todo/in_progress/done. The project write
transaction acquires the project lock, rechecks membership, compares the exact
version and only then handles same-state. A current same-state request returns
the full current Task without a stored write; stale same-state conflicts. Actual
change increments once. Entering active/done requires all direct predecessors
done, including external edges; reopening done refuses sorted direct active/done
dependent IDs. No dependent is changed. Status preserves requiredPlatform, PRs,
other task fields, dependency classifications and attachments. Claim-bound done atomically marks
the current worker completed; its owner and claim ID must match. Active execution
returns to todo only through release. Released unfinished work requires original
resource continuity through automatic acquisition or explicit manual resume. The
old four lifecycle routes are removed.

Execution timing describes the current attempt. Actual entry into in_progress
uses statement_timestamp() after the lock and clears the end; return to todo
clears both. In-progress to done preserves its nullable start and records an end;
todo to done records an end with null start. Metadata and same-state preserve time.
No missing historical start is inferred. State, timing, version and update time
commit atomically. Details are owned by the [status architecture](../../docs/design/daynight-task-status.md).

Migration 014 converts historical proposed rows to todo, advancing only their
version/update time and preserving every other field, including timing. It
atomically changes the default, rows, CHECK and ledger; restart does not rerun it.
Applied historical migrations are immutable. Runtime input and readers reject proposed.

Migration 013_task_required_platform.sql adds nullable required_platform with its
enum CHECK, preserving old versions, timestamps and other fields. Full tasks and
graph nodes always expose requiredPlatform as null/windows/linux/macos. PATCH
distinguishes omitted/set/null; exact-version same-value preserves version/time,
stale values conflict and actual in-progress changes reject the whole edit.
Platform, permission and status changes preserve each other. TaskPlatform.Valid
and PlatformCompatible(required, actual) own null/exact compatibility without
inferring worker identity from the server OS. Explicit manual status setting
remains available regardless of automatic eligibility.

Permission PATCH distinguishes omission from false, rejects null/nonboolean,
checks version before same-value handling and rejects actual changes while
in_progress as invalid_transition. Explicit task execution accepts either value;
automatic discovery requires true. The [claim foundation](../../docs/design/daynight-worker-claims.md)
rechecks eligibility and ownership in the same transaction. PR order and duplicates
remain significant. Readiness changes do not advance dependent task revisions.

Expected refusals are returned only after the lock-only transaction succeeds;
transaction/cleanup failures preserve operational errors. Reads use an RR snapshot.
Task cursors bind project and optional status/ready/allowAgents/compatiblePlatform
filters, retaining absent/false and absent/each-enum distinctions. Compatibility
includes unrestricted and exact-platform tasks; all filters run in SQL before
ordering, limit and lookahead, so a bounded page cannot hide later compatible work.

## Complete task graph

`GET /api/v1/projects/{projectId}/task-graph` reads the project, exact graph size,
all graph nodes and their dependency projections in one read-only repeatable-read
transaction. It returns `{project, summary, tasks, observedAt}` with no pagination or filters.
Nonempty query strings fail with 400, including unsupported parameters and invalid
encodings. Responses use `Cache-Control: no-store`.

`observedAt` is a fresh UTC database statement timestamp sampled after graph data
has been read. It shares the clock authority of task execution timestamps without
changing stored task metadata. Its changing value is not graph-content identity;
clients preserve task/index identity on clock-only responses.

The summary requires total, todo, inProgress, done, ready and blocked, including
zero values. Each project task counts once: `total = todo + inProgress + done`
and `todo = ready + blocked`. Only todo contributes to ready/blocked; ready means
all direct prerequisites are done. Task/get/list/graph and status filters accept
only three states. Graph reads do not change stored status, revisions or time.

Nodes contain `id`, `titlePreview`, `titleTruncated`, `status`, `dependsOn`,
`externalDependsOn`, `blockedBy`, `ready`, required boolean `allowAgents`,
required nullable enum `requiredPlatform`, UTC creation/update timestamps and explicit nullable
`startedAt`/`completedAt`. SQL produces at most 160 Unicode code
points of each title without selecting descriptions, properties or full titles. Use the
existing task detail endpoint for complete content. Node order is `(createdAt,
id)`; dependency arrays are sorted and empty collections encode as `[]`.
`externalDependsOn` is a duplicate-free subset of the complete `dependsOn` set.
Blocking, readiness, cycle validation and graph-size limits use every edge.
Migration `012_external_dependencies.sql` initializes existing edges to ordinary
without rewriting endpoints or task metadata.

Projects above 1,000 nodes or 5,000 edges return 409 `graph_limit_exceeded` with
exact `nodeCount`, `edgeCount`, `maxNodes` and `maxEdges` in `error.details`.
The response contains no partial graph. Missing projects return 404. Operational
or transaction-completion failures take precedence over missing/limit refusals.

Graph requests share the existing request ID and safe error handling. Logs add
project identity and graph counts without recording task content or repository
addresses. This endpoint supports the implemented
[task dashboard](../../docs/design/daynight-web.md); the browser application
and embedded static delivery are implemented.
From the repository root, `pnpm web:acceptance` builds this executable and runs
production browser workflows against both a native process and the dev-ci
container gateway. It owns separate PostgreSQL resources; its prerequisites,
receipts and fixed-capacity gates are in the
[web README](../daynight-web/README.md#production-browser-acceptance).

## Task HTTP API

Worker operations return complete Task resources with 200 and no-store, preserving
existing authentication, exact int64 versions and strict JSON/error handling.
They do not start processes. Claims use fresh caller-persisted UUIDs; the latest
ID cannot be reused, and current-owner writes must match the claim. Transfer
checks source authorization separately from target membership and platform.
Release preserves original resources; manual resume requires source owner/admin
and continuity while retaining the explicit manual eligibility exception. The
[claim architecture](../../docs/design/daynight-worker-claims.md) owns exact fields
and refusals. Callers of the in-process typed client reconcile unknown results by GET of
known task IDs; no reverse owner query or claim table is introduced.

| Method | Path | Result |
|---|---|---|
| `POST` | `/api/v1/projects/{projectId}/tasks` | `201`, task and `Location` |
| `GET` | `/api/v1/projects/{projectId}/tasks` | `200`, task page |
| `GET` | `/api/v1/projects/{projectId}/tasks/{taskId}` | `200`, task |
| `PATCH` | `/api/v1/projects/{projectId}/tasks/{taskId}` | `200`, updated metadata/dependencies |
| `PUT` | `/api/v1/projects/{projectId}/tasks/{taskId}/status` | `200`, exact-version status; done may include current claimId |
| `POST` | `/api/v1/projects/{projectId}/tasks/{taskId}/worker-claim` | `200`, atomic automatic acquisition |
| `PATCH` | `/api/v1/projects/{projectId}/tasks/{taskId}/worker-claim` | `200`, current owner updates execution summary |
| `POST` | `/api/v1/projects/{projectId}/tasks/{taskId}/worker-claim/release` | `200`, source owner/admin confirms stopping and returns todo |
| `POST` | `/api/v1/projects/{projectId}/tasks/{taskId}/worker-claim/transfer` | `200`, source owner/admin installs validated target ownership |
| `POST` | `/api/v1/projects/{projectId}/tasks/{taskId}/worker-claim/resume` | `200`, explicit manual continuation of released original work |

Creation accepts required `title`, optional `description`, `dependsOn`,
`externalDependsOn`, `requiredPlatform` and `properties`; omitted optional values
mean empty text, empty complete/external dependency sets, unrestricted platform
and an empty PR list. Status, version and identity are server-owned on creation.
The external subset must belong to the final complete dependency set. On PATCH,
omitting both fields preserves relationships; dependsOn-only replaces IDs and
keeps surviving classifications with new edges ordinary; externalDependsOn-only
keeps IDs and replaces the exact external subset; both supplied replace both.
Removing an edge removes its marker. Metadata and status updates
preserve unrelated classification and execution timing. Exact write examples
belong to the [external dependency design](../../docs/design/daynight-external-dependencies.md).
PATCH accepts a positive integer `version` and at least one mutation of `title`,
`description`, `dependsOn`, `externalDependsOn`, `allowAgents`,
`requiredPlatform` or `properties.pullRequests`; a status field is rejected
even alongside otherwise valid metadata. Omitted fields
stay unchanged; explicit `requiredPlatform: null` clears the requirement. Null
for other fields, including dependency or PR elements, fails.
Empty description, `dependsOn: []` or `properties: {"pullRequests": []}` clears
that value. `properties: {}` has no mutation intent and is accepted only with
another mutable field. Fractions, exponents, strings and out-of-range versions fail.

Full read `properties` contains the server-defined `pullRequests` ordered array
and required `worker:null` or a typed active/released/completed execution record.
Public create/PATCH accepts only writable PR properties; providing worker, even
null or unchanged, is invalid_input. PR edits preserve worker. Each PR item
requires exactly string fields `url` and `title`. Strings preserve their decoded
JSON content, including empty text, whitespace, controls and NUL; order and
duplicate items are data. The server performs no URL, PR, provider, repository
or title-content checks and fetches no external metadata. Supplying a list
replaces the complete list; omission preserves it. Unknown fields, duplicate
keys, null, wrong types and missing item fields fail at every object level.
The existing UTF-8, single JSON object and 1 MiB request limit apply, with no
additional count or string-length limits. The complete API behavior is owned by
the [task properties requirements](../../docs/spec/daynight-task-properties.md).

Task responses contain identity, project, title, description, status, required
boolean `allowAgents`, nullable enum `requiredPlatform`, version,
UTC creation/update timestamps, explicit nullable execution timestamps
`startedAt`/`completedAt`, sorted `dependsOn`/`externalDependsOn`/`blockedBy` arrays, `ready` and complete
`properties` with an initialized `pullRequests` array and explicit worker. A missing
project or a task outside the specified project returns 404. The initialized
empty project returns `items: []`, `nextCursor: null`.

Lists support `limit`, `cursor`, `status`, `ready`, `allowAgents` and
`compatiblePlatform`, once each.
Both boolean filters accept literal `true` or `false`; compatibility accepts
`windows`, `linux` or `macos` and includes null requirements and exact matches.
Filters combine with AND before ordering, pagination and lookahead and remain bound to the
cursor's canonical project scope. HTTP input uses the same strict JSON and
query rules as project operations.

Lifecycle POST bodies require only the positive int64 expected version, as a
JSON number. Missing, null, fractional, nonpositive and out-of-range versions fail.
The project transaction checks version before the current task lifecycle state,
then dependency rules; success increments once and preserves unrelated fields. Repeated actions
fail, and refusals leave fields, versions and timestamps intact.

Version conflicts, wrong predecessor states, dependency cycles and unmet
dependencies return 409 with `version_conflict`, `invalid_transition`,
`dependency_cycle` or `dependency_unsatisfied`.
Relevant sorted IDs appear in `error.details.taskIds`. Operational failures
remain 500, and cancelled requests write neither response body nor creation
Location. Parsed project/task IDs and the request ID correlate safe logs; known
refusals use their domain `error_code` and cause instead of an internal label.

For example, after saving a PAT through setup and obtaining a project ID:

```bash
daynight task create --project PROJECT_ID --title "Implement API"
daynight task set-status TASK_ID in_progress --project PROJECT_ID --if-version 1
daynight task set-status TASK_ID done --project PROJECT_ID --if-version 2
```

To inspect a failure, match its response `requestId` with JSON logs on stderr:

```bash
jq 'select(.request_id == "REQUEST_ID")' .tmp/server.jsonl
```

Capture stderr to that project-local path when starting the process; submitted
URLs, bodies, SQL and credentials are excluded from logs.

## Built-process acceptance and CI evidence

The same check retains the original actual-process scenarios, installed CLI
project/task and attachment workflows, and the
[installed lifecycle migration/race scenarios](cmd/daynight-server/acceptance_lifecycle_cli_test.go).
The normal real-UniAuth fixture supplies sessions/PATs and explicit membership;
installed commands use private origin-matched PAT configuration. Authentication
and authorization remain on the production resource path. TestMain freshly builds a
race-enabled server, starts only owned loopback children against isolated real
PostgreSQL schemas, and checks HTTP workflows, restart persistence, competing
mutations, PR string/NUL/order/duplicate persistence, partial-write rollback,
cancellation, graceful/forced SIGTERM,
migration failures and simultaneous startup. This signal acceptance runs in the
Ubuntu Go CI job. Independent scenario subtests run with at most four concurrent
slots within their sequential top-level test; each retains its own schema,
processes, database barriers and cleanup. This keeps other top-level tests'
process-wide environment changes outside the parallel scenario lifetime.
Existing three-platform CLI validation remains separate. The
[CI efficiency decision](../../.agents/notes/implemented/testing/2026-10-21-ci-validation-efficiency.md)
records the validation-cost trade-offs.

The test process incrementally writes `.tmp/acceptance-evidence.json` with the
checked-out Git/GitHub SHA, required root `gitTreeSha` from
`git rev-parse HEAD^{tree}`, dirty state, Go/PostgreSQL versions, tested binary
SHA-256, named results and cleanup counts. The installed CLI receipt's
`source.gitTreeSha` must match that tree as well as the existing revision,
package and artifact checks. Missing or mismatched source identity fails. CI
requires a clean checkout and a revision matching `GITHUB_SHA`. All children stop before schemas are removed;
the receipt records reaping, removed schemas and disappearance of owned sessions.
Every fixture also requires `storageRootRemoved`: the owned root is removed and
its absence is checked before cleanup can pass. The temporary tested binary is removed after the run; its hash remains in the
receipt.

The [binary scenarios](cmd/daynight-server/acceptance_test.go) and their
[process/evidence harness](cmd/daynight-server/acceptance_process_test.go) map to
the [V1–V10 requirements](../../docs/spec/daynight-server.md) as follows:

| Requirement | Observable evidence |
|---|---|
| V1: persistent resources | `workflow_restart_persistence`, `graceful_sigterm_drains_committed_request`, `forced_sigterm_cancels_without_late_write`; complete objects survive process restart and listener reuse |
| V2: dependency refusal and rollback | `refusals_scopes_filters_and_cursors`, `partial_write_http_failure_rolls_back`; rejected writes preserve complete tasks, with a sequence proving metadata and the first edge changed before the injected failure |
| V3: concurrency and project independence | `concurrent_reverse_dependencies`, `canceled_request_and_independent_project`; owned backend waiters prove competing requests and independent progress |
| V4: state gates | `three_state_read_projection`, `concurrent_status_same_version`, `concurrent_dependency_update_and_status`, `concurrent_reopen_and_successor_status` plus installed start/done/distinct-target/dependency-edit/same-state races; [service tests](internal/service/task_test.go) and [HTTP status tests](internal/server/task_transitions_test.go) cover all nine pairs, +0/+1, stale no-op and ordinary/external predecessor/dependent protection |
| V5: revisions and no-ops | Workflow/refusal scenarios and `concurrent_same_version`; actual changes compete on one version and matching semantic no-ops retain fields/timestamps |
| V6: listing and HTTP contract | `refusals_scopes_filters_and_cursors`, [HTTP tests](internal/server/tasks_test.go) and service tests cover tied keysets, scoped filters, initialized empty resources, DTOs and error mapping |
| V7: transactions and lifecycle | Partial-failure, cancellation, graceful/forced-signal, unsupported/failed-migration-history, concurrent-startup and `installed_cli_pre_lifecycle_migration_restart` scenarios; owning store tests prove finer snapshot and cross-migration interleavings |
| V8: coverage and race gates | [`scripts/check.sh`](scripts/check.sh), [`.go-cov.toml`](.go-cov.toml), the raw profile and [exact-boundary/malformed-profile tests](scripts/coverage.test.mts) |
| V9: mandatory infrastructure and complete CI | Missing/unavailable PostgreSQL fails the check; test-result expiration preserves real observations; the [final `checks` job](../../.github/workflows/checks.yml) accepts only `success` or `skipped` from every preceding job and rejects failures, cancellations and other results under the [repository CI rules](../../README.md#ci-selection); main pushes run all modules |
| V10: correlation and privacy | Workflow/refusal/partial-failure/cancellation/startup scenarios verify HTTP request IDs, canonical resource IDs, structured categories and absence of submitted secret markers from logs |

HTTP error assertions preserve expected status/code, JSON response headers and
exact error.requestId/X-Request-ID correlation. Known secret markers and database
URLs are checked across the entire body. SQL-marker checks cover the complete
JSON envelope, including unknown fields and keys, while masking only the direct
error.requestId string after unique, syntactically valid header correlation.
Other original bytes and nested requestId fields remain diagnostic content. The [acceptance metadata decision](../../.agents/notes/implemented/bug-fix/2026-10-21-http-error-acceptance-metadata.md)
explains why a legal opaque ID may contain the SQL marker.

The installed CLI project/task scenario and its artifact/source validation live
in [`acceptance_cli_test.go`](cmd/daynight-server/acceptance_cli_test.go). Its
mixed unfinished/completed fixture verifies the exact default and `--all` list
membership and order. Each JSON array equals the complete task resources after
removing only `description`, retaining raw PR strings, timestamps and exact int64
versions; task show retains the full description. Human lists retain identity,
status, readiness, dependencies and escaped PR references while omitting
description, version and timestamps; `task show` retains those detail fields.
Both detail and all-status list output preserve visible PR control-character
escaping without emitting raw terminal controls.

The independent [platform/status scenario](cmd/daynight-server/acceptance_platform_cli_test.go),
`TestInstalledCLIPlatformAcceptance` / `installed_cli_platform_status_workflow`,
owns a separate PostgreSQL fixture, installed CLI workspace and server process.
It checks all four required-platform values across nine status pairs, exact +0/+1,
platform and material preservation, compatibility-filtered candidates, explicit
clear, stale/no-op behavior and in-progress platform refusals. It requires graceful
SIGTERM exit 0 and the fixture's normal cleanup receipt. The original project/task
workflow retains its assertions; the platform matrix has its own unchanged
45-second server lifetime. Runtime success remains established by source-bound
acceptance receipts, separately from this scenario inventory.

The [attachment scenario](cmd/daynight-server/acceptance_attachment_cli_test.go)
reuses the same packed/installed CLI and real-process fixture. It checks exact
text, empty and multi-chunk binary bytes above 1 MiB; nested/special paths,
different-directory basenames, overwrite metadata, a complete list of more than 100 files
requiring multiple pages, tree output, deletion, scoped/refusal/requestId behavior and
ordinary missing-content errors. The full task snapshot stays unchanged. Actual
restart reuses the same root and compares all remaining metadata and bytes.
`attachmentFiles` retains path/size/SHA-256, `attachmentsListed` and
`attachmentPageRequests` record complete pagination, and existing
`cliRefusalRequestIds` retains correlated failures; file bodies are not receipts.
K1 remains recorded only, without asserting cross-store rollback.
The [combined acceptance decision](../../.agents/notes/implemented/testing/2026-10-21-task-attachment-cross-layer-acceptance.md)
owns this proof alongside the same-data CLI/browser journeys.

The [status scenarios](cmd/daynight-server/acceptance_lifecycle_cli_test.go)
reuse the packed installation and actual-process fixture.
`TestInstalledCLIStatusMigrationAcceptance` runs installed_cli_v12_status_migration_restart
against genuine checked-in migrations 001–012, then lets the current service apply
013 platform followed by 014 status. The status-only preservation oracle separately starts
from genuine prefix13 and compares non-null platform requirements across14;
v12 rows first gain the expected nullable platform column. It compares raw historical rows and checksum ledgers: proposed changes to todo
once with version/update-time advancement; non-proposed rows and all other fields,
timing, permission, properties, ordinary/external edges and attachment bytes survive.
Database defaults/CHECK, overflow rollback and restart idempotence are separate
oracles. Explicit fixture membership establishes test access without adopting
legacy projects or rewriting migration history.

`TestInstalledCLIStatusRacesAcceptance` starts two real installed processes with
one observed version. Installed scenarios are installed_cli_same_version_start,
installed_cli_same_version_done, installed_cli_same_version_distinct_targets,
installed_cli_same_version_dependency_edit_and_start and installed_cli_same_version_same_state.
Project-row locks and observed waiters order actual requests. Changed races require
one committed winner and one visible version_conflict; current same-state contenders
both succeed without changing stored fields. Correlated request IDs, process exits,
complete snapshots and attachment bytes prove no hidden retry or material loss.
Service/native ordinary/external reopening versus successor-start/complete races
provide separate interleaving evidence; one process order does not prove every order.
Settings acceptance retains real saves, no-ops, conflicts, project isolation and
nested exact-int64 CLI readback. Optional lifecycle receipts record source, migration,
snapshot, request/process and restart evidence without treating fixture preparation
or a mocked client as runtime proof.
The [cross-layer decision](../../.agents/notes/implemented/testing/2026-10-22-task-lifecycle-cross-layer-acceptance.md)
owns these methods and their relationship to production browser journeys.

The Node orchestrator reuses that installation for six budget probes after the
Go coverage gate. Deadline probes load a test-only preload with 1-second request
and 3-second operation deadlines, while separately asserting the installed
production defaults of 30 seconds and five minutes. Four decoded-byte probes use
the unchanged 128 MiB/256 MiB defaults and exact-limit/+1-byte pairs. Each probe's
`deadlines` records `totalMs`, `requestMs` and whether it was mocked in the root
`.tmp/project-task-service-evidence.json` receipt. Successful package-level
coverage and actual process results are separate evidence: binary HTTP tests
supplement the store/service/server package tests.
The owning store/service tests retain deterministic snapshot and lock proofs:
`TestQueriesSnapshotRetainsCompleteOldGraph` in [query tests](internal/core/store/query_test.go),
`TestTaskSnapshotKeepsProjectAndDerivedTaskStateConsistent` in
[service failure tests](internal/service/task_failure_test.go), and
`TestMigrationsSessionLockSpansCommits` in [migration tests](internal/core/store/migrate_test.go).

CI uploads `daynight-server-acceptance` after validation, including the JSON
receipt and raw `.tmp/coverage.out`, even when validation fails. Artifacts are
retained for 30 days. Inspect the artifact from the exact workflow run: a PR run
normally tests a merge revision, so the receipt identifies the tested checkout.
Build and result must be `passed`; all expected scenarios and their cleanup must
pass; process start/reap counts must agree; every schema/session cleanup must be
confirmed, including actual removal of each fixture's storage root. Recompute
the strict coverage comparison from the accompanying raw
profile rather than its rounded display. A failed job, partial receipt or local
pass does not establish successful hosted acceptance for another source revision.
Lasting technical findings belong in the relevant
decision or research records.
