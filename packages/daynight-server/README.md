# daynight-server

The Go service owns PostgreSQL-backed project and task management. Its runtime
foundation is implemented: explicit database and file-storage configuration,
loopback-only HTTP binding, connection validation, structured request logs, cancellation, and bounded
HTTP shutdown. Versioned migrations and transactional storage are implemented;
project/task APIs and built-process acceptance are implemented. The current
executable serves project, task, task-chain graph, task-summary synchronization
and account-owned Worker snapshot routes together with the embedded task dashboard.
Generic bucket/path local storage, task attachment
metadata and file/preview HTTP endpoints are implemented. Attachment addresses
are grouped by project and the first two canonical task UUID characters; an
explicit offline maintenance command migrates the old task-only layout.
Dependency rows also
persist an ordinary/external classification and task/graph reads expose the
required external subset. Public create and versioned PATCH accept explicit
classification while preserving all-edge execution and project authorization.

The [requirements](../../docs/spec/daynight-server.md) own observable behavior and
the [design](../../docs/design/daynight-server.md) owns architecture and concurrency.
The TypeScript review command retains its separate configuration, storage and
lifecycle. The client HTTP foundation targets this service's API.

The [assignment contract](../../docs/spec/daynight-task-assignment.md) and
[design](../../docs/design/daynight-task-assignment.md) define the native nullable
Task assignee. Ordinary task creation/PATCH and full Task, summary and graph
producers carry it. Native assignee filtering and project-scoped people reads
are implemented. The Web consumes assignment with schema-4 cache rebuilding,
people presentation, mutation and local list filters. The CLI consumes the required
nullable field and supports assignment/clearing, current-ID output and explicit
list filters.

The [authentication requirements](../../docs/spec/daynight-auth.md) and
[architecture](../../docs/design/daynight-auth.md) define UniAuth identity
handoff, local users, browser sessions, personal access tokens and project
membership. The [identity foundation](../../.agents/notes/implemented/architecture/2026-10-22-identity-credentials.md)
implements persistent users, browser-bound login transactions, sessions, PATs and
callable HTTP handlers. NewIdentity/NewAuthentication/RegisterRoutes are composed by the runtime. The [membership foundation](../../.agents/notes/implemented/architecture/2026-10-22-project-membership.md)
adds NewMemberships/NewMembershipRoutes, transaction-scoped access checks, private
project creation, filtered project lists, administrator changes and invitations.
Stored `ProjectGrant` facts and their real observation versions are distinct from
computed `ProjectAccess`. The authenticated
`GET /api/v1/projects/{projectId}/access` returns exactly
`{effectiveRole,directGrant}`. Both keys are required; a present grant contains
only its project/user IDs, stored role, int64 JSON-number version and UTC creation
and update times. The current direct source returns the actual grant; failed
admission remains an error. It returns no member profiles, accepts no query
parameters, supports GET/HEAD and preserves the principal response header and
no-store policy. Resource admission and accessible-project filtering use
the canonical direct-authorization source; the existing member response joins
grant facts with nullable profile fields without changing its public JSON.
Worker administrator checks consume access, while claim ownership and acquisition
assignment requirements retain their separate rules.
The project settings API provides a versioned execution-warning threshold that
administrators save and members read.
The application mux mounts all of these modules and requires authentication for
every project, task, graph, attachment and Worker snapshot route. The production Web entry separates
the public introduction at `/`, the zero-API guide at `/setup`, and the existing
`AuthenticatedApp` lifecycle for `/login`, `/projects` and private pages.
`daynight login` uses Daynight device authorization to obtain
a nonexpiring `Daynight CLI (<hostname>)` Bearer credential named for the initiating machine. Explicit PAT configuration remains
available for automation. Existing projects are assigned members
manually and remain inaccessible while they have no members. Trusted executable
HTML retains its application origin, relative resources and keyboard behavior.
The [activation decision](../../.agents/notes/implemented/architecture/2026-10-22-authentication-activation.md)
owns composition and credential-private validation; current delivery results
require receipts bound to the tested source.

The [task-summary synchronization requirements](../../docs/spec/daynight-task-sync.md)
and [architecture](../../docs/design/daynight-task-sync.md) define the implemented
`GET /api/v1/projects/{projectId}/task-sync` endpoint. It returns a complete summary
snapshot or current records whose `updatedAt` is at least the supplied task
watermark minus `DAYNIGHT_TASK_SYNC_OVERLAP` (default `10s`). Task versions use
exact decimal strings; each intrinsic summary includes explicit nullable
assignedTo and the complete current properties object, while descriptions,
derived blockers and readiness remain outside these summaries. Task rows and batched property rows share one
repeatable-read snapshot. Every snapshot and delta, including an empty delta,
also returns required top-level `actorAccess` using the access endpoint's DTO.
The existing admission result supplies it in the same snapshot; its nested grant
version remains an exact int64 JSON number. Browser consumers publish access only
to the current identity/project memory owner, outside persistent Project and Task
records. Missing keys propagate removal through whole-summary
replacement; ordinary property changes preserve the epoch. Invalid stored
properties fail the complete request with 400 invalid_input. Database and
transaction-completion faults remain 500 internal_error and take precedence over
a saved property validation refusal. A stored project epoch invalidates caches after supported
history replacement and transactional task soft deletion. The Web persists
summaries and details and replaces them atomically after an epoch change. Its
schema-4 upgrade directly rebuilds project, summary and detail stores from
versions 1, 2 or 3, rotates user fences and clears old watermarks before a complete
snapshot. Strict assignedTo consumption and that cache-format upgrade are
delivered together. Absent properties or assignedTo in old summaries cannot be
inferred as an empty object or null. Graph nodes omit properties,
and cached values grant no detail or mutation admission. Complete properties
increase transport, parsing and summary storage costs: node/edge limits and the
detail-cache byte budget do not bound total summary bytes. Network, decoding and
quota failures retain the previous valid cache without partial publication or
watermark advancement.
The [task deletion requirements](../../docs/spec/daynight-task-deletion.md) and
[design](../../docs/design/daynight-task-deletion.md) define versioned DELETE,
retained task/attachment data and active target-worker protection. Omitted or
false `removeDepends` preserves strict reference refusal; explicit true removes
all incoming ordinary/external references, including deleted-source history,
updates each affected source version once and marks the target in one transaction.
The target's own prerequisites remain. Target removal and one epoch rotation are
atomic, with the task-local `410 task_deleted` response for later access.

Herdr Task Sessions use explicit `daynight.session.v2` selection with the shared
Session registry and archive storage. The [terminal server design](../../docs/design/terminal-session-server.md)
defines routes, Worker capability gates, durable recording evidence and control
ACKs. These server APIs do not establish native Worker or browser readiness.

## CLI device authorization

The CLI connects to `https://daynight.cc` when `serverUrl` is omitted. An explicit
server URL supports test deployments. `daynight login` displays a verification
URL and a ten-letter code; `/device` reuses the ordinary browser login and
requires explicit approval or denial with the current account. Both browser
operations require a valid session and exact main-site Origin. A PAT cannot
approve another device. Decisions bind the reviewed account through required
`expectedUserId`; a changed browser account is refused before grant mutation.
`daynight logout` revokes its current Bearer credential.

| Endpoint | Contract |
|---|---|
| `POST /api/v1/auth/device/code` | RFC 8628 form request with `client_id=daynight-cli`; returns device and human codes, verification URLs, 600-second lifetime and five-second polling interval |
| `POST /api/v1/auth/device/token` | Form request with the device grant type, client ID, device code and required `device_name`; returns a Bearer credential once |
| `POST /api/v1/auth/device/inspect` | Browser JSON `{userCode}`; returns canonical code, expiry and pending/approved/denied/expired/consumed status |
| `POST /api/v1/auth/device/decision` | Browser JSON `{userCode,decision:"approve"|"deny",expectedUserId}`; returns 204 for a new decision |
| `POST /api/v1/auth/device/logout` | Authenticated Bearer request; deletes only the current credential and returns 204 |

The CLI reads its OS hostname once when login begins and sends it as `device_name`
on every token poll, even when the browser approval happens on another machine.
The service accepts 1–255 valid UTF-8 Unicode characters, requires a nonblank
value without control characters, and returns `invalid_request` for missing or
invalid names without consuming the grant. It uses the first 85 characters inside
`Daynight CLI (<hostname>)` to satisfy the existing 100-character PAT name limit.
The name is client-supplied display metadata, not machine authentication. Existing
credential names remain unchanged.

PostgreSQL stores only device-secret and credential hashes. Grant decisions and
redemption are serialized; consuming one approved grant and inserting one named
PAT commit atomically. A lost successful token response requires a fresh login;
consumed grants cannot issue the secret again. The account token page can revoke
`Daynight CLI (<hostname>)` credentials and edit the expiration of an active token without
changing its secret or requiring another CLI login. `null` means never expires;
a future UTC timestamp sets an expiration. Existing finite expirations retain
their original values. Browser sessions keep their fixed seven-day lifetime.
There is no refresh token.

The persistent polling schedule returns `authorization_pending` while waiting,
`slow_down` for an early poll with a five-second interval increase,
`access_denied` after denial, `expired_token` after expiry, and `invalid_grant`
after consumption. Public endpoints use RFC error JSON; browser endpoints use
the normal Daynight error envelope. All responses are `no-store`. Nonexpiring token responses omit OAuth
`expires_in`; the device authorization code still expires after ten minutes.

Persistent one-minute budgets limit creation to 120 requests globally and 30 per
direct connection source; browser code inspection and decisions share 120 global
attempts and 12 per user. Forwarded headers do not control the source key.
Expired rate buckets and grants are cleaned in batches of at most 100. Grants
remain for one hour after expiry so their approving user can reconcile an
uncertain decision; another account cannot inspect a decided grant.

## Token expiration management

`POST /api/v1/me/tokens` requires `{name,expiresAt}`, with `expiresAt` explicitly
`null` for no expiration or a future UTC timestamp ending in `Z`. Legacy `days`
input is rejected. Token metadata always contains nullable `expiresAt`.

`PATCH /api/v1/me/tokens/{tokenId}` requires
`{expiresAt,expectedExpiresAt,expectedUserId}` and returns the complete token
metadata with status 200. The current browser session and exact main-site Origin
are required. `expectedUserId` binds the reviewed account, and
`expectedExpiresAt` must equal the observed nullable expiry. A stale observation
returns 409 `version_conflict`; a changed account returns 403. Missing, revoked,
and expired tokens return 404 and cannot be restored through this operation.

Updates lock the token row inside the existing session transaction and preserve
the token ID, name, creation time and hash. A matching unchanged value returns
200 without a write. An uncertain response is reconciled by reading the token
list before another decision. Dates are returned in UTC; new finite expirations
use PostgreSQL microsecond precision. Revocation remains the explicit immediate
invalidation action. Expiry and revocation affect subsequent credential admission.

## Layout

| Path | Responsibility |
|---|---|
| `cmd/daynight-server/` | Environment, process signals, dependency assembly, exit status and direct command tests |
| `cmd/e2e_tests/` | Test-only package for built-process, installed-CLI and attachment-migration acceptance |
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
| `DAYNIGHT_TASK_SYNC_OVERLAP` | Positive Go duration subtracted from a supplied task-summary watermark | `10s` |

Wildcard, non-loopback, hostname, scoped IPv6, and malformed listen addresses are
rejected. Callback paths that collide with application routes are rejected during
configuration and startup validation before route registration; this includes
`/login`, `/setup` and every descendant path. If an existing callback occupies that
namespace, choose another path and register its exact full URL in UniAuth before
starting the server. Login return loops, including `/login`, are rejected before a
login transaction is created. An absent return target defaults to `/projects`; a
known callback failure redirects to the explicit login error page and retains the
validated target, including when local session creation fails. Only the configured callback path is routed; there is no fixed-path alias or authentication-disable
mode. The two HTTP exceptions control different origins and do not imply each
other. The exact `/setup` page uses the normal embedded HTML GET/HEAD handler,
no-store policy, 405/Allow response and request logging. Its public static guide mounts
outside the browser authentication flow and makes no API requests.
`/healthz` and `/readyz` are public GET/HEAD endpoints; readiness checks
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
The response returns `X-Request-ID`. Successfully authenticated handlers also
return `Daynight-User-ID` from the admitted principal, including empty mutations
and later resource errors. Failed authentication does not emit that header;
caller-supplied values are not echoed. An unmatched route has an empty route template.
UI and API requests use the same logging wrapper. Exact `/device`, `/account`,
`/invitations`, `/`, `/login`, `/projects`, `/workers`, `/workers/{workerId}`, `/setup`,
`/projects/{projectId}`, `/projects/{projectId}/members`,
`/projects/{projectId}/settings`, `/projects/{projectId}/tasks/{taskId}` and
`/projects/{projectId}/tasks/{taskId}/attachments/{path...}` page shapes return
the index. Worker routes open account-owned runtime observations through the
existing snapshot APIs; task/project data in those observations remains filtered
by current project access. The task routes open complete standalone details, with the attachment
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
`Allow`. HTML, task-chain graphs and latest task details use
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

The complete check runs the shared root `pnpm web:build`, prepares the pinned
real-UniAuth integration fixture, and runs coverage and E2E validation in
sequence. Use `bash scripts/check.sh --coverage` or `bash scripts/check.sh --e2e`
to run either responsibility independently. Each mode prepares its required Web,
UniAuth and installed CLI inputs after the caller supplies the isolated
`DAYNIGHT_TEST_DATABASE_URL`.

Coverage mode builds the executable, runs `go vet`, expires project-local Go test
results so database changes cannot be hidden by cached coverage, and runs
race-enabled package tests through `go-cov` pinned to commit
`d6caf2759e330b48d69a543695e37002a48feb1d`. The checked-in `.go-cov.toml`
requires at least 85% coverage per production package and 80% per function,
with critical blocks enforced and no production exclusions. The Node orchestrator
passes the full import path of `cmd/e2e_tests` to `--exclude-packages`, removing
that test-only package from coverage execution. Because the tool uses substring
matching, `go list ./...` must confirm that the full-path match selects exactly
that package; extended or nested matches fail. The orchestrator also recursively
rejects non-test Go source in that directory, preventing this exception from
hiding production statements. All production packages and their raw coverage profile
remain in the gate. A separate exact calculation over that profile requires
overall statement coverage **strictly greater than 90%**. Exactly 90% fails. The
check also tests that calculation's boundary and malformed-profile behavior.
Coverage mode retains the authentication package's installed-CLI assertions and
normally issued PAT producer, followed by the two deadline probes and installed
fixture cleanup. It writes `.tmp/project-task-service-evidence.json` at the
repository root and `.tmp/coverage.out` in this module.

E2E mode runs `go test -race -count=1 -timeout=10m ./cmd/e2e_tests`. Its own packed
and installed CLI belongs to that run; the package freshly builds a race-enabled
server and retains every process, concurrency, error-path and cleanup assertion.
It writes this module's `.tmp/acceptance-evidence.json` and the repository-root
`.tmp/project-task-e2e-evidence.json`, which records command results, installed
artifact identity and installed-fixture removal. Deadline probes and their PAT
handoff remain in coverage mode. Each orchestration receipt also records the
source revision, tree, dirty state and actual package list.

`scripts/env.sh` places downloaded tools, dependencies, caches, binaries and
temporary outputs under this module's `.tmp/`. The Go coverage, Go E2E and Web
browser CI jobs restore module and compiler caches using `go.sum`. Coverage
expires test results; E2E's `-count=1` also requires a fresh run. The two server
jobs run independently on separate runners with separate PostgreSQL services,
using the same server selector and a 20-minute bound each. The final `checks`
job waits for both. The `daynight-server-acceptance` artifact contains coverage
and deadline evidence; `daynight-server-e2e-acceptance` contains process/scenario
and E2E installation evidence. Both upload existing diagnostics after validation
failure as well as success.

Ordinary Go discovery excludes stress-tagged files. With an isolated test
database configured, run `bash scripts/stress.sh` explicitly for the
10,000-task/100-person query sample, full-scale Session-v2 archives and repeated
concurrent overwrite workload. It uses race detection and selects only
`TestStress*` in the three owning packages. The script and raw tagged test
entrypoints refuse a nonempty `CI` environment. CI retains compact archive
boundary checks and a deterministic two-writer publication test. The query sample
remains source-bound local evidence, rather than a production capacity limit.
The tests cover real database connection/query cancellation, HTTP cancellation,
graceful and forced drain, listener/pool reuse, process configuration/exit status
and log redaction.

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
restore commands. Before reopening a restored/imported history, rotate affected
projects.task_cache_epoch values; a saved UUID is itself part of the backup.
A matching pair preserves the state captured; it does not
repair a pre-existing cross-store mismatch. Browser management and CLI commands
remain separate from the backend file API below.

The [real-container attachment check](../../deployment/dev-ci/README.md#attachment-persistence-check)
covers nonroot volume writes, nested original bytes and previews, restart and
full recreation, isolation between deployments, targeted cleanup and fresh-volume
paired restore followed by another upload. Single-instance project and shard
isolation is checked separately using one database and storage root.

## Attachment layout maintenance

The same executable provides an explicit offline entry point:

```bash
daynight-server migrate-attachment-layout plan
daynight-server migrate-attachment-layout apply --operation-id OPERATION_UUID
daynight-server migrate-attachment-layout resume --operation-id OPERATION_UUID
```

It reads only `DAYNIGHT_DATABASE_URL` and `DAYNIGHT_STORAGE_ROOT`, performs
read-only database queries, and does not start HTTP, initialize authentication or
run automatic SQL migrations. No arguments still select ordinary service startup;
unknown command grammar fails before connecting or listening. Maintenance returns
0 on success and 1 on failure. Success stdout is one compact JSON summary with
operationId, phase (`planned` or `complete`), taskCount, fileCount, totalBytes,
unregisteredCount, manifestPath and receiptPath. Paths are storage-root relative;
plan has a null receiptPath. JSON diagnostics use stderr and preserve safe
operation/category/phase correlation without credentials or host paths.

Stop all server instances and direct database/file writers, retain the old image,
and capture a matching database/directory backup before planning. Keep writers
stopped through migration and verification. The database advisory lock serializes
maintenance invocations; it does not prevent application writes.

Planning prepares and synchronizes the complete manifest and initial planned
state in a private `.attachment-plan-<operationId>/` directory, then atomically
promotes that directory to the reserved `.attachment-layout-<operationId>/`
namespace and synchronizes the storage root. A visible official operation thus
already has both initial records. Ordinary errors before promotion clean only
that attempt, preserving any cleanup error. Process-termination leftovers contain
no attachments, are ignored by operation discovery and do not prevent a new
plan; maintenance does not sweep other attempts. Errors after promotion retain
the official records for explicit same-operation continuation. The plan_created
event and success summary follow promotion.

A manifest binds the operation to database/schema identity, unchanged business
rows and the complete source tree, including empty task roots/directories and
regular-file SHA-256 values. Known-task unregistered regular files are preserved
and reported without creating metadata. Unknown ownership, registered missing or
size-mismatched files, symlinks, special files and target conflicts fail explicitly.
An unfinished operation rejects a new plan as `resume_required`, identifying the
operationId to resume even if its old bucket is absent and the attachment table
is empty. A completed operation rejects a new plan as `already_migrated` with
its operationId; use apply/resume for that same operation to verify it. This
also prevents a completed tree containing only known-task unregistered files
from being nested again when project and task UUIDs happen to match.

The command stages the whole old bucket under an operation directory inside the
configured storage root, then moves complete task trees into project/shard/task targets. Full target
content and a fresh independent database snapshot are checked before publication.
No target is overwritten or merged. This separate namespace handles a valid
project UUID equal to an old task UUID. Three normal full hash passes cover
planning, pre-move revalidation and pre-publication verification; file bytes are
streamed. A final rename publishes the already-verified tree, followed by
structure/size/metadata checks and a completion receipt. Resume reconciles only
manifest-explained positions, including publication before its receipt; it does
not guess from directory names or repair K1. Empty plans and completed operations
remain explicitly verifiable.

The command preserves business metadata, existing schema and task cache epochs.
Rollback uses the retained image and matching paired backup; restoring historical
database content follows that version's epoch invalidation contract. Restore
before reopening writers to avoid discarding new writes. The
[architecture](../../docs/design/daynight-task-attachments.md#存量布局迁移) owns the
state and failure rules; the
[upgrade runbook](../../deployment/localhost/README.md#attachment-layout-upgrade)
owns the operator sequence.

## Task attachment API

For `T=/api/v1/projects/{projectId}/tasks/{taskId}`, the service provides:

| Method and path | Behavior |
|---|---|
| `GET T/attachments` | Metadata page, using existing limit/cursor and items/nextCursor |
| `PUT T/attachments/files/{path...}` | Raw single-file creation (201) or overwrite (200) |
| `GET T/attachments/files/{path...}` | Original bytes with download disposition |
| `DELETE T/attachments/files/{path...}` | Delete one registered file (204), missing record 404 |
| `GET T/preview/{path...}` | Inline same-origin content and relative resources |

Run `daynight login` and approve its displayed device code in the Web workspace.
With existing project/task IDs, upload a local document:

```bash
daynight task attachment put TASK_ID ./design.md --project PROJECT_ID --path docs/design.md
```

The path is relative to the task, preserves case, and each URL segment is encoded
individually. No request uploads or replaces a directory. A missing content type
means `application/octet-stream`; invalid types are rejected. Binary uploads do
not use the existing 1 MiB JSON decoder.

Metadata is stored in `task_attachments`, keyed by task and path with C collation;
the service derives the storage address as
`task-attachments/<canonicalProjectId>/<canonicalTaskId[:2]>/<canonicalTaskId>/<path>`.
Canonical IDs and the original task-relative path are validated before adding
that prefix. The shared business-layer mapper serves runtime and maintenance
operations; the generic Storage interface remains bucket/path only. API/CLI
parameters, returned paths, content URLs and relative preview resources retain
their existing logical form. List cursors bind the
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
lock. Target task reads for mutation also lock the parent row before property
changes. Session relay keeps its shared parent-task lock before reading worker
and session state; a missing property row cannot replace that fence. The lock
order is project (when used), parent task, properties, then session/freeze.
Returning an error rolls back fields, properties, dependencies, version and
timestamps together. Only expose a captured resource after the outer call
succeeds.

`Store.ReadSnapshot` uses read-only `REPEATABLE READ` for project/task queries and
derived readiness, with membership and resource reads in the same snapshot.
Project-list membership filtering precedes pagination. Pages use a validated limit and optional `(createdAt, id)`
position; status/readiness filters run before keyset pagination. Page lookahead
is returned as `HasMore`; HTTP cursor encoding belongs to the API layer.

`Store.WriteWorker` is an independent `READ COMMITTED` transaction for account-owned
Worker observations. It updates only the matching Worker row, atomically preserving
server report time, telemetry and normalized task observations. It does not acquire
a project lock or mutate task ownership. Snapshot reads batch-filter saved task
references by current project membership and undeleted-task visibility. The
[Worker snapshot design](../../docs/design/daynight-worker-snapshots.md) owns this
separate storage and current-permission behavior.

The shared `core.Project` and `core.Task` models have one representation across
storage and service. Store queries report prerequisite/dependent records and
candidate reachability. The static property registry in `internal/taskproperties/`
owns native validation, normalization, schemas and public writability. Generic
maps preserve every property key. Each task/property is a `task_properties` row,
keyed by task_id/name, with one complete JSON value stored as text. JSON-escaped
NUL retains its existing string semantics without SQL JSON conversion. Full
reads batch-load properties in the same snapshot as their selected parent tasks.
The frozen property-row migration covers soft-deleted tasks, preserves existing
PR values including empty arrays, maps worker:null to absence, retains non-null
claim/session identity, and leaves task versions/times unchanged. Old SQL and
checksums remain immutable; the new checksum includes the frozen transform.
Public mutations reject protected worker values. Missing properties are not
materialized, and illegal stored properties fail the complete HTTP operation
with 400 invalid_input; database failures remain 500 internal_error. The HTTP
boundary and value codecs share strict object decoding in `internal/jsonobject/`.
Property PUT receives unchanged argument text as valueText; it decodes JSON or
string shorthand through the definition rather than trusting client validation.
The complete JSON envelope, including its extra escaping, shares the 1 MiB request
limit. DELETE removes the row and omits the key; null is never a delete marker.
Both require the exact task version and return the resulting PropertyResource.
Equal sets and absent repeated deletes are no-ops after version validation.

The service owns reference validation, DAG/state rules, optimistic version
comparison and semantic no-ops. These task resources have no foreign keys or
hard-delete operations. Direct database writers must not bypass these service rules.

Store tests use unique owned schemas and real PostgreSQL sessions. They prove
old-schema property migration with unchanged metadata, multi-migration exclusion,
rollback after partial writes, snapshot consistency, project-lock serialization,
independent projects and cancellation. Index-definition assertions resolve the
fixture's schema-qualified object before deparsing it; predicates on a global
catalog view can evaluate a deparser before namespace filtering. Correct,
wrong-order and missing-index cases retain a same-named fallback-schema index to
verify isolation. The [index assertion decision](../../.agents/notes/implemented/testing/2026-10-24-schema-owned-index-assertions.md)
records the query-ordering rationale. Rollback and advisory unlock use
independent bounded contexts and preserve original causes.

## Worker runtime snapshots

The authenticated account owns one latest observation per stable Worker ID.
Clients register or refresh it through the report endpoint; task claims and
ordinary task timestamps do not create or renew this resource. The
[contract](../../docs/spec/daynight-worker-snapshots.md) defines the complete typed
report and response fields, and the
[design](../../docs/design/daynight-worker-snapshots.md) defines independent
transactions and permission-filtered reads.

| Method | Path | Result |
|---|---|---|
| `POST` | `/api/v1/me/workers/{workerId}/report` | `200`, server `observedAt` and retained `lastReportedAt` |
| `GET` | `/api/v1/me/workers` | `200`, recent Worker summaries and an account-bound cursor |
| `GET` | `/api/v1/me/workers/{workerId}` | `200`, telemetry and visible task observations |

All routes use normal PAT/session admission, exact Cookie-write Origin and
`Daynight-User-ID`; responses are `no-store`. Report and detail requests accept no
query parameters. List uses `limit` (default 50, maximum 100) and `cursor`. The
recent window includes exactly 72 hours; 120 seconds without a report is offline
when consumers compare the returned server clock with `lastReportedAt`. GET does
not refresh liveness. Unknown, other-account and expired detail reads return 404.

Reports use closed Probe states, explicit unknown inventory and a full task
reference array. A known empty array is distinct from inventory that has never
been synchronized. Task titles, status and phase come from current owned claims.
Reports and reads use the store's canonical project access relation for the
authenticated user, currently backed by direct grants. Subsequent reads preserve
saved observations while applying current access and undeleted-task filtering
to both rows and counts. Completion or reassignment
does not erase an otherwise visible historical observation. Liveness and recent
visibility do not control claims or task state.

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
and unrestricted requiredPlatform=null unless explicitly supplied. Its
assignedTo defaults to null; an explicitly supplied UUID must identify a current
project member in the creation transaction.
It rejects caller-supplied status, timing and permission; platform creation accepts
null or windows/linux/macos. PATCH retains field presence separately from nullable value. Properties/PRs and both
dependency collections have explicit empty defaults. Updates require a positive
expected int64 version and at least one mutable field; omitted pointers preserve
values, while empty description/dependency/PR lists clear them.
requiredPlatform and assignedTo accept null to clear; other JSON null input is
rejected.
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
dependent IDs. No dependent is changed. Status preserves requiredPlatform, assignedTo, PRs,
other task fields, dependency classifications and attachments. Claim-bound done atomically marks
the current worker completed; its owner and claim ID must match. Active execution
returns to todo only through release. Released tasks begin a new execution through eligible automatic acquisition or
explicit owner/admin resume, with fresh claim and worktree IDs. The
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

Migration 028_task_assignment.sql adds nullable assigned_to and a partial
project/assignee/keyset index for undeleted tasks. All existing and soft-deleted
tasks receive NULL without changes to versions, business timestamps, properties
or execution identity. Task, summary and graph responses always emit assignedTo
as null or a canonical local user UUID.

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
automatic discovery requires true and assignedTo matching the authenticated
local user ID. Unassigned or other-user tasks fail automatic claim with
409 invalid_transition, preserving fields, version and timestamps. Worker
candidates use assignedTo=me before pagination; complete claim inventory omits
assignment filtering, and explicit manual resume retains its owner/admin rules.
The [claim foundation](../../docs/design/daynight-worker-claims.md)
rechecks eligibility and ownership in the same transaction. PR order and duplicates
remain significant. Readiness changes do not advance dependent task revisions.

Expected refusals are returned only after the lock-only transaction succeeds;
transaction/cleanup failures preserve operational errors. Reads use an RR snapshot.
Task cursors use version 2 and bind project, the resolved
all/unassigned/user:UUID assignee selection and optional
status/ready/allowAgents/compatiblePlatform filters, retaining absent/false and
absent/each-enum distinctions. Optional UUID
workerId also binds the implicit authenticated user ID and matches only that
user/worker active claim. Ordinary eligibility filters remain SQL predicates;
worker ownership is matched by decoding each candidate’s worker property row
before collecting the final limit+1 matches; complete properties are batch-loaded
for selected tasks. Assignee equality/IS NULL applies before this worker
matching and final pagination. No bounded output page hides later matches, and
opaque PR strings are not converted through PostgreSQL JSON types. Project and
account-Worker cursors stay at version 1; old version-1 task cursors are refused.
The assignee filter is explicit and does not change automatic worker eligibility.

## Task-chain graph

`GET /api/v1/projects/{projectId}/task-graph?taskId={taskId}` requires one task UUID.
The service reads the project, validates the live target, counts the selected
graph and reads its compact nodes in one read-only repeatable-read transaction.
Missing, empty, repeated or malformed `taskId`, unsupported query parameters and
invalid URL encoding return 400 `invalid_input`. Responses use
`Cache-Control: no-store`; there is no project-wide fallback or pagination.

Ordinary dependencies are `dependsOn` minus `externalDependsOn`. Treating those
edges as undirected, the graph contains the entire connected component of the
selected task, including every status, branch and join. It also contains each
external prerequisite directly declared by any component member. These context
nodes do not expand further: their prerequisites, ordinary chain and external
dependents are not added. Tasks outside the component that externally depend on
a member are not selected. A standalone task forms its own component.

The response remains `{project, summary, tasks, observedAt}`. Each selected task
counts once; the summary requires total, todo, inProgress, done, ready and blocked,
including zero values. `total = todo + inProgress + done` and
`todo = ready + blocked`. Only todo contributes to ready/blocked; readiness still
uses every original direct prerequisite, including prerequisites outside this
projection. Graph reads do not change stored status, revisions or timestamps.

Nodes contain `id`, `titlePreview`, `titleTruncated`, `status`, `dependsOn`,
`externalDependsOn`, `blockedBy`, `ready`, required boolean `allowAgents`, required
nullable enum `requiredPlatform`, required nullable user UUID `assignedTo`,
UTC creation/update timestamps and explicit
nullable `startedAt`/`completedAt`. SQL produces at most 160 Unicode code points
of each title without selecting descriptions, properties or full titles. Use the
task detail endpoint for complete content. Node order is `(createdAt, id)`;
dependency arrays are sorted and empty collections encode as `[]`.

Each node retains all original dependency and blocker IDs. `externalDependsOn`
is the external subset of the complete `dependsOn` set. A context node may refer
to prerequisites whose task rows are intentionally absent; consumers must retain
those references rather than interpret the projection as a dependency closure.

`observedAt` is a fresh UTC database statement timestamp sampled after graph data
has been read. It shares the clock authority of task execution timestamps without
changing stored metadata. Its changing value is not graph-content identity.

Selected graphs above 1,000 nodes or 5,000 original dependency edges return 409
`graph_limit_exceeded` with exact `nodeCount`, `edgeCount`, `maxNodes` and
`maxEdges` in `error.details`. Counts include context rows and all their original
outgoing dependencies, including references beyond the projection. Unrelated
project tasks and edges do not consume these limits. Refusal returns no partial
graph. Missing projects or tasks return 404; an authorized deleted target returns
410 `task_deleted`. Project authorization precedes target lookup. Operational or
transaction-completion failures take precedence over domain refusals.

Graph requests share the existing request ID and safe error handling. Logs add
project identity and graph counts without recording task content, repository
addresses or query strings. The CLI uses this endpoint; the Web dashboard uses
`task-sync` and computes its graphs locally.

## Task Steps API

Task-owned Steps persist independently from Sessions and expose dedicated reads,
atomic collection additions, content updates, independent status settings,
position moves and current-record deletions. The
[resource contract](../../docs/spec/daynight-task-steps.md) owns field,
identity, permission, version, encoding and refusal semantics. Migration 030
stores normalized rows without changing existing Task fields or migration
checksums. Steps remain outside ordinary Task, list, graph and synchronization
projections.

For `T = /api/v1/projects/{projectId}/tasks/{taskId}`:

| Method | Path | Result |
|---|---|---|
| `GET` / `HEAD` | `T/steps` | Complete ordered projectId/taskId/version/steps resource; empty is `[]`. |
| `GET` / `HEAD` | `T/steps/{stepId}` | Parent identity/version and complete `step`; the eight-hex input is case-insensitive. |
| `POST` | `T/steps` | `201`, canonical item `Location` and complete ordered collection after append or before/after insertion. |
| `PATCH` | `T/steps/{stepId}` | `200`, complete ordered collection after an atomic title/description update or no-op. |
| `PUT` | `T/steps/{stepId}/status` | `200`, complete ordered collection after an independent status setting or no-op. |
| `PUT` | `T/steps/{stepId}/position` | `200`, complete ordered collection after a before/after/first/last move or no-op. |
| `DELETE` | `T/steps/{stepId}` | `200`, complete remaining collection after deleting the specified current record; the last deletion returns `steps: []`. |

Requests accept no query, including a trailing empty `?`. Unsupported collection
methods return an authenticated `405` with `Allow: GET, HEAD, POST`; item methods
return `Allow: GET, HEAD, PATCH, DELETE`; status and position methods, including HEAD, return
`Allow: PUT`. Both project roles can read and modify Steps. Normal Task
nonmembership/missing scope is `404`, parent soft deletion is `410`, and a missing
child or anchor is `404`. Responses retain `no-store` and principal/request
receipts; Cookie writes require the configured Origin.

Writes accept one JSON object within 1 MiB and require a positive exact int64
`version`. POST also requires a caller-chosen eight-hex `id` and `title`. Omitted
`description` is empty and omitted `status` is `todo`; the four statuses are
`todo`, `in_progress`, `done` and `skipped`. Optional `before` and `after` are
mutually exclusive and refer only to the same Task. IDs normalize to lowercase;
title and Markdown retain their originals. Duplicate titles create independent
records; an existing ID always conflicts.

Content PATCH accepts only `version` and at least one of `title`/`description`.
Omitted fields preserve their values; an empty description clears it. A paired
update saves both fields atomically. Status PUT accepts only `version` and a
required four-state value; all transitions are allowed, including multiple
in-progress Steps and updates while the parent Task is done. Both update the
same existing record and return a full collection without a new Location.

Position PUT accepts only `version` and exactly one of `before`, `after` or
`position`. Relative anchors are another Step in the same Task; `position` is
the string `first` or `last`, never a boolean field. Target and anchor IDs
normalize before placement checks. After parent/version admission and target
resolution, a self-anchor is `400 invalid_input`;
a missing target or anchor is `404` without a fallback position or cross-Task
lookup. The target moves within the complete collection, preserving every
Step's ID, title, description, status and created/updated timestamps. It returns
a full collection without a new Location.

DELETE accepts only a JSON `version` and removes the Task-local current record
in any Step state. It returns the complete remaining collection, including an
explicit empty array when the last record is removed, with no new Location.
A missing target is a child `404`, never a successful no-op. Stale versions
conflict before target lookup; a current missing target is checked before version
exhaustion. Deleting an existing target always changes the collection and refuses
at MaxInt64. The deleted ID becomes available for a later explicit POST, which
creates a new record with its own creation time and submitted content/defaults;
it does not restore the former record. No history, recovery or bulk deletion
resource is provided.

Unknown/duplicate/read-only fields, explicit null, wrong types, NUL, invalid
UTF-8 and lone escaped UTF-16 surrogates are refused. Valid surrogate pairs,
literal U+FFFD and escaped backslashes are preserved.

Reads use one repeatable-read snapshot and a narrow Task header, independent from
properties and execution policy. Writes use the existing project transaction and
lock order: project, member admission, narrow parent lock, tombstone and exact
version, then current rows. Add checks duplicate ID before anchor and constructs
an immutable insertion candidate. Content/status changes share one actual
existing-target change path, resolve that Task's target and compare merged
semantic values before assigning time. Move resolves the target and any anchor
and copies the final order without changing content or times. Current same-value
updates and already-occupied positions are no-ops: the old complete resource, version and all times are returned without a clock
sample, target/position UPDATE or parent touch. Adjacent relative moves, first/last
boundaries and valid singleton moves follow the same rule, including MaxInt64.
Stale same-value requests still conflict; a missing target is a child 404 before
version exhaustion; a missing anchor remains a distinct child absence. Delete
resolves its current target and builds a copied remaining collection with dense
positions; its empty result is a non-null array and has no no-op branch.

Real changes check exhaustion, sample database UTC microsecond time, encode the
complete candidate, persist only the intended rows and touch the parent once.
Add shifts affected positions and inserts one row. Content/status changes update
only the target's title/description/status/updated_at; its ID, position and
created_at remain fixed. Move writes only the affected interval's final dense
positions with one CASE UPDATE and leaves all Step timestamps unchanged; the
deferred unique constraint checks the final order without sentinel positions.
Delete physically removes one current row and compacts only its trailing
positions. Every survivor retains its identity, content, status, timestamps and
relative order. The remaining candidate passes complete codec preflight before
target deletion, compaction or parent touch.
For content/status changes, the one clock sample equals the target's new
updatedAt and the parent's updated_at; for Move and Delete it belongs to the
parent alone.
No-op versus real-change competition can produce two successful responses when the
no-op finishes first, but only one actual change advances the shared version.
Concurrent same-version actual Task and Steps writes permit at most one change.

Steps preserve Task business fields, properties, dependencies, execution timing
and Worker/Session ownership. Deleting a Step also preserves referenced
attachments, PRs and Sessions. Task state, disabled automatic execution, absent
Sessions and active Worker ownership do not restrict Steps. No Steps write
freezes a Session or calls the full Task updater.

`internal/tasksteps` is the sole public DTO/codec owner. Exact Encoder output
includes default escaping and terminal LF, with 19 version digits reserved
within 67,108,864 bytes. A frozen successfully encoded collection is the response
body. An over-limit real-change candidate returns `409 steps_limit_exceeded`
with `encodedBytes` and `maxEncodedBytes` details before any data mutation; a
status string-length increase uses the same check. Shrinking a description
follows the same full-resource/version rules. Other write refusals are
`409 version_conflict`, `409 step_id_conflict` for Add and `409 version_exhausted`
for actual changes. Invalid stored rows, non-dense order, read over-capacity,
database failures and failed transaction cleanup are internal errors; the service
never substitutes a partial or empty result.

The shared transaction owner preserves operation, commit and cleanup failures
and their original causes. Confirmed Commit remains `committed` after response
loss; confirmed rollback is `not_committed`; unconfirmed Commit is `unknown`.
The driver's closed-transaction cleanup after failed Commit cannot prove rollback.
Cleanup failure outranks a nested business refusal. The handler logs fixed safe
diagnostics under `component=task_step`, `operation=add|update|set_status|move|delete`, business
`changed`/`unchanged` and prepare/persist/commit/response phases. No-op skips the
persist phase; its business `unchanged` is independent from a `committed`
transaction. Logs omit input values and arbitrary Fault/driver messages.
Transaction outcome is independent from `response_outcome=written|failed|canceled_before_body`
and `written_bytes`. A completed network write does not prove client receipt.
Recovery GET request IDs may append `.r1`, `.r2` and so on to the original ID;
`read_kind=reconcile`, version and found/absent/current-state observations describe
current facts without attributing them to an unknown write. Clients retain the
original identity and do not replay writes automatically. Current absence after
an unknown deletion does not attribute that state to the operation, and a current
same-ID record does not establish that it is the original record.

Routine tests cover migration preservation, scoped reads, snapshot interleaving,
raw text, exact int64, auth/Origin/HEAD/query/method refusals, malformed storage,
append/anchors/defaults, atomic content and four-state changes, dense moves,
self/missing anchors, current-record deletion, ID reuse, no-op/exhaustion,
concurrency, parent and Session preservation, rollback and completion facts, and
safe response diagnostics. The focused change cases are `TestTaskStepsChange*`
and `TestStepsHTTPChange*`; move cases are `TestTaskStepsMove*` and
`TestStepsHTTPMove*`; deletion cases are `TestTaskStepsDelete*` and
`TestStepsHTTPDelete*`. Actual binary read restart persistence is covered by
`TestBuiltBinaryStepsReadPersistence`. After preparing the normal auth fixture
and an isolated PostgreSQL database, focused tests can be run from this module:

```bash
source scripts/env.sh
export DAYNIGHT_TEST_DATABASE_URL='postgres://.../isolated-test-database'
export DAYNIGHT_TEST_UNIAUTH_FIXTURE="$(node scripts/prepare-uniauth-fixture.mts)"
go test ./internal/core/store ./internal/service ./internal/server -run 'Test(Transact|TaskSteps|Steps)' -count=1 -timeout=5m
```

Maximum-resource HTTP tests use the `stress` build tag and run separately from
routine CI:

```bash
go test -tags=stress ./internal/server -run '^TestStepsHTTP(ExactCapacity|AddCapacity|ChangeCapacity|MoveCapacity|DeleteCapacity)Stress$' -count=1 -timeout=5m
```

The read case seeds legitimate bounded individual records, observes complete
64 MiB HTTP bytes at the maximum int64 version, checks the same content at a
one-digit version, and refuses an illegally seeded over-capacity collection.
The add case checks an exact successful candidate and subsequent complete GET,
then a one-byte over-limit candidate with no data writes. The change case checks
an exact PATCH and GET, one-byte over-limit refusal before target UPDATE/touch,
shrinking, status length increases and legal maximum no-op. The move case checks
an exact-capacity move and subsequent GET, preserved Step times and a maximum
version no-op without clock, position UPDATE or parent touch. Routine PostgreSQL
cases verify interval-write and parent-touch rollback and same-version competition.
The delete case checks removal from a maximum legal resource through actual HTTP
bytes and the complete remaining GET; routine cases verify target/tail/parent-touch
rollback, terminal empty collection, current target absence and new-record ID reuse.
Run-specific results and source identity belong to the corresponding PR evidence.

## Task Thread API

Persistent discussion belongs to each task independently of its execution.
The [Thread requirements](../../docs/spec/daynight-task-thread.md) and
[design](../../docs/design/daynight-task-thread.md) own the complete contract.
Thread never changes Task version, timestamps, state, properties, dependencies,
cache epoch or task-sync. It remains readable and writable before execution,
while the Controller is offline, and after completion. Deleted tasks retain
messages but refuse access through their task resource.

Writes use canonical `store.LockProjectAuthorization` with Task share,
credential share, actual direct-grant share and head update locks in that order.
The positive grant remains locked through commit; admission returns current
locked-row role and real grant facts after any wait. It acquires no Project row
lock or profile projection. The final credential-expiry check follows all waits
and encoding. Ordinary resource and Session admission keep their existing
nonlocking access reads.

For `T=/api/v1/projects/{projectId}/tasks/{taskId}`:

| Method | Path | Result |
| --- | --- | --- |
| `POST` | `T/thread/messages` | `201`, committed default message; body, optional replyTo/claimId |
| `GET` / `HEAD` | `T/thread/messages` | `200`, messages and actual-boundary hasMoreBefore/hasMoreAfter |

GET accepts only beforeId/afterId (mutually exclusive), count=1..100 (default 50),
details=true/false and internal fromBeginning=true/false. An explicit
fromBeginning cannot accompany an Id boundary. Without a boundary, ordinary
reads select the latest page; fromBeginning=true selects the oldest page. Pages
always display oldest first. Unknown, repeated or empty query keys fail; POST
accepts no query and strictly decodes one UTF-8 JSON object within 1 MiB.

A message contains id, author.userId/displayName/Agent, body, fixed-three-digit
UTC createdAt and optional replyTo. displayName is always present and may be
null. Author name and verified execution attribution are immutable snapshots.
A supplied claimId must be active and owned by the authenticated account;
otherwise Agent=false. details=true exposes only verified claimId, workerId and
provider under author.execution for Agent authors. Neither default messages nor
ordinary users expose that object. The database generates message_id once; its
primary key is (task_id,message_id), with no single-column uniqueness guarantee.
Reply and pagination IDs are always resolved within the selected task.

The shared codec admits both default/detailed message encodings at <= 65,536
bytes and complete pages at <= 262,144 bytes. HTTP writes exactly those escaped
JSON bytes without an added LF. Full bodies and names are never truncated.
Service operations have a 10-second ceiling with shorter parent deadlines taking
precedence; actual-clock advancement has a 100 ms sub-budget, and rollback uses
an independent 5-second cleanup context. These bounds do not claim a whole-handler
latency SLA.

POST success follows confirmed commit. A failed cleanup remains 500 even with a
nested business refusal. Unknown COMMIT returns 503 message_outcome_unknown;
clients keep drafts and must not automatically repeat POST. A post-commit
response failure is logged once at response phase without another append.
Clock-budget exhaustion returns 503 clock_not_advanced; encoded oversize is 413
payload_too_large. Missing local messages are 404 message_not_found. Invalid or
expired credentials are 401, missing project membership or source-owner mismatch
is 403, invalid/stale claim is 409, and deleted tasks are 410. Existing PAT/Cookie,
Origin, no-store and Daynight-User-ID behavior applies.

Store/service tests use real isolated PostgreSQL schemas to check composite
identity, millisecond ordering, rollback/commit stages, expiry, authorization,
immutable attribution, byte admission and ID paging. HTTP tests verify strict
input, real Cookie/PAT authentication, actual response lengths and safe failure
logs. Private clock seams and injected commit-response loss make failure paths
deterministic; these are bounded observations, not proof of every network fault.
Run the full server gate under [Validate](#validate). CLI rendering and browser
Discussion are separate consumers of this API.

## Task HTTP API

Worker operations return complete Task resources with 200 and no-store, preserving
existing authentication, exact int64 versions and strict JSON/error handling.
They do not start processes. Claims use fresh caller-persisted UUIDs; the latest
ID cannot be reused while retained, and current-owner writes must match the claim.
Release retains the last resource fields as history after source cleanup. Manual
resume requires source owner/admin, previousClaimId and fresh claim/worktree IDs
while retaining the explicit manual eligibility exception. Force withdrawal accepts
the exact version and matching active/released claim ID from its original owner
or a project admin who remains a member. It atomically clears worker, returns
todo, clears execution timing and sets allowAgents=false, preserving other
materials. It requires no stoppedConfirmed and does not guarantee immediate
remote process stopping; the original worker discovers absence through its
complete own-claim inventory and performs terminal cleanup.
Deprecated continuityConfirmed input is rejected rather than ignored. The
[claim architecture](../../docs/design/daynight-worker-claims.md) owns exact fields
and refusals. Callers of the in-process typed client reconcile unknown results by GET of
known task IDs. Automatic cleanup instead requires the complete authenticated
user/worker active-claim inventory; no claim table is introduced.

| Method | Path | Result |
|---|---|---|
| `POST` | `/api/v1/projects/{projectId}/tasks` | `201`, task and `Location` |
| `GET` | `/api/v1/projects/{projectId}/tasks` | `200`, task page |
| `GET` | `/api/v1/projects/{projectId}/tasks/{taskId}` | `200`, task |
| `GET` | `/api/v1/projects/{projectId}/task-assignees` | `200`, scoped minimal people catalogue or bounded userId resolution |
| `GET` | `/api/v1/task-properties/schema` | `200`, authenticated server-wide definitions without project discovery |
| `GET` | `/api/v1/projects/{projectId}/tasks/{taskId}/properties` | `200`, projectId/taskId/version and complete properties |
| `PUT` | `/api/v1/projects/{projectId}/tasks/{taskId}/properties/{name}` | version/valueText; `200`, property resource after setting one complete value |
| `DELETE` | `/api/v1/projects/{projectId}/tasks/{taskId}/properties/{name}` | version; `200`, property resource with the removed key absent |
| `PATCH` | `/api/v1/projects/{projectId}/tasks/{taskId}` | `200`, updated metadata/dependencies |
| `PUT` | `/api/v1/projects/{projectId}/tasks/{taskId}/status` | `200`, exact-version status; done may include current claimId |
| `POST` | `/api/v1/projects/{projectId}/tasks/{taskId}/worker-claim` | `200`, atomic automatic acquisition |
| `PATCH` | `/api/v1/projects/{projectId}/tasks/{taskId}/worker-claim` | `200`, current owner updates execution summary |
| `POST` | `/api/v1/projects/{projectId}/tasks/{taskId}/worker-claim/release` | `200`, source owner/admin confirms stopping and returns todo |
| `POST` | `/api/v1/projects/{projectId}/tasks/{taskId}/worker-claim/withdraw` | `200`, owner/admin clears active/released ownership, returns todo and disables automatic execution |
| `POST` | `/api/v1/projects/{projectId}/tasks/{taskId}/worker-claim/resume` | `200`, explicit manual new execution of a released task |

Creation accepts required `title`, optional `description`, `dependsOn`,
`externalDependsOn`, `requiredPlatform`, `assignedTo` and `properties`; omitted
optional values mean empty text, empty complete/external dependency sets,
unrestricted platform, no assignee and no property rows. Status, version and
identity are server-owned on creation.
The external subset must belong to the final complete dependency set. On PATCH,
omitting both fields preserves relationships; dependsOn-only replaces IDs and
keeps surviving classifications with new edges ordinary; externalDependsOn-only
keeps IDs and replaces the exact external subset; both supplied replace both.
Removing an edge removes its marker. Metadata and status updates
preserve unrelated classification and execution timing. Exact write examples
belong to the [external dependency design](../../docs/design/daynight-external-dependencies.md).
PATCH accepts a positive integer `version` and at least one mutation of `title`,
`description`, `dependsOn`, `externalDependsOn`, `allowAgents`,
`requiredPlatform`, `assignedTo` or a writable defined property; a status field
is rejected
even alongside otherwise valid metadata. Omitted fields
stay unchanged; explicit `requiredPlatform: null` clears the requirement and
`assignedTo: null` clears responsibility. Null for other fields, including
dependency or PR elements, fails.
Empty description, `dependsOn: []` or `properties: {"pullRequests": []}` clears
that value. `properties: {}` has no mutation intent and is accepted only with
another mutable field. Fractions, exponents, strings and out-of-range versions fail.

Assignment is top-level task metadata, independent of properties and worker
claims. Non-null UUID input is normalized before candidate equality and target
membership is checked in the project transaction only for a newly selected
person. A real assignment change atomically sets allowAgents=false, including a
combined PATCH requesting true; in_progress rejects the complete change. An
equal assignment preserves permission and does not requalify a retained former
member. Ordinary metadata, status, property and worker writes share one complete
current-task copy and preserve assignment. The common policy runs after
definitive no-op/deletion handling; domain refusals retain transaction-failure
priority. Assignment grants neither project access nor control of a claim,
Session or archive, and does not limit another eligible worker after automatic
selection is enabled.

Full read `properties` is a generic object of defined property names to complete
JSON values. Keys may be absent; no default PR array or worker:null is injected.
A retained worker is a typed active/released/completed claim object. Public
create/PATCH and single-property mutations reject worker, even unchanged.
PR edits and internal worker mutations preserve each other and all other keys. Each PR item
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
boolean `allowAgents`, nullable enum `requiredPlatform`, explicit nullable user
UUID `assignedTo`, version,
UTC creation/update timestamps, explicit nullable execution timestamps
`startedAt`/`completedAt`, sorted `dependsOn`/`externalDependsOn`/`blockedBy` arrays, `ready` and complete
`properties` with its actual present keys. An empty object means no properties,
and an explicit `pullRequests: []` remains distinct from absence. A missing
project or a task outside the specified project returns 404. The initialized
empty project returns `items: []`, `nextCursor: null`.

Task lists support `limit`, `cursor`, `status`, `ready`, `allowAgents`,
`compatiblePlatform`, `assignedTo` and UUID `workerId`, once each.
Both boolean filters accept literal `true` or `false`; compatibility accepts
`windows`, `linux` or `macos` and includes null requirements and exact matches.
assignedTo accepts a UUID, `me` or `unassigned`; omission means all assignments.
`me` resolves to the admitted principal before cursor checking, while unassigned
matches native NULL. A former assignee UUID remains a valid filter.
Explicit filters combine with AND before final pagination and lookahead and stay
bound to the cursor's canonical project scope. workerId includes only current
active claims for the authenticated user and that worker; it adds no implicit
status, readiness, permission or platform eligibility condition. Only a workerId-only
query aggregated successfully across all relevant projects/pages supplies a complete
ownership inventory. Partial pages, additional filters and failed traversals cannot
authorize cleanup by absence. HTTP input retains strict query validation.
Task cursor version 2 includes the resolved assignee scope; me and its concrete
UUID may share that scope, but another account's me cannot. Project and
account-owned Worker list cursors remain version 1.

The project-scoped task-assignees GET returns `items` and `unresolvedUserIds`
as non-null arrays. With no query it enumerates current members and assignees
retained by undeleted tasks. Repeated `userId` query arguments select a bounded
resolution mode: 1–100 distinct canonical UUIDs, with no empty, duplicate,
malformed or unknown parameters. Both arrays are sorted; in resolution mode
they are disjoint and cover the requested IDs exactly. The complete catalogue
has an empty unresolved array. HEAD and method refusal retain the authenticated
GET/no-store/Allow contract.

Each item has only userId, nullable name, nullable avatarUrl and boolean
hasProjectAccess. Values preserve the canonical profile; no name or email
fallback is synthesized, and email, external identity, role, version and
execution records are not returned. No scoped membership or live-task reference
means unresolved, regardless of whether a global user exists. A raw qualifying
reference whose users row is missing is an internal integrity failure, not an
unresolved ID or a null name. Both modes authorize and read references/profiles
within one repeatable-read snapshot and fail as a whole on query, scan, rows,
cancellation or transaction-completion errors.

Full catalogue reads are intended for explicit selection/retry. Recurring
consumers resolve their rendered/selected IDs in batches of at most 100; an empty
set sends no request rather than omitting arguments and enumerating everything.
The [assignment contract](../../docs/spec/daynight-task-assignment.md) owns the
privacy, qualification and error rules. Neither mode mutates Task versions.

Lifecycle POST bodies require only the positive int64 expected version, as a
JSON number. Missing, null, fractional, nonpositive and out-of-range versions fail.
The project transaction checks version before the current task lifecycle state,
then dependency rules; success increments once and preserves unrelated fields. Repeated actions
fail, and refusals leave fields, versions and timestamps intact.

Version conflicts, wrong predecessor states, dependency cycles and unmet
dependencies return 409 with `version_conflict`, `invalid_transition`,
`dependency_cycle` or `dependency_unsatisfied`.
Relevant sorted IDs appear in `error.details.taskIds`. Malformed stored property values return 400 invalid_input with a preserved
validation cause; database and other operational failures remain 500. No path
returns partial properties or silently repairs invalid values. Cancelled
requests write neither response body nor creation
Location. Parsed project/task IDs and the request ID correlate safe logs; known
refusals use their domain `error_code` and cause instead of an internal label.

For example, after running `daynight login` and obtaining a project ID:

```bash
daynight task create --project PROJECT_ID --title "Implement API"
daynight task set-status TASK_ID in_progress --project PROJECT_ID --if-version 1
daynight task set-status TASK_ID done --project PROJECT_ID --if-version 2
daynight task properties --schema --json
daynight task properties TASK_ID --project PROJECT_ID --json
daynight task set-property TASK_ID pullRequests '[{"url":"https://github.com/owner/repo/pull/123","title":"Fix synchronization"}]' --project PROJECT_ID --if-version 3
daynight task remove-property TASK_ID pullRequests --project PROJECT_ID --if-version 4
```

To inspect a failure, match its response `requestId` with JSON logs on stderr:

```bash
jq 'select(.request_id == "REQUEST_ID")' .tmp/server.jsonl
```

Capture stderr to that project-local path when starting the process; submitted
URLs, bodies, SQL and credentials are excluded from logs.

## Built-process acceptance and CI evidence

The test-only [`cmd/e2e_tests/`](cmd/e2e_tests/) package owns the actual-process
scenarios, installed CLI project/task and attachment workflows,
[installed lifecycle migration/race scenarios](cmd/e2e_tests/acceptance_lifecycle_cli_test.go)
and [offline attachment migration](cmd/e2e_tests/migrate_attachment_acceptance_test.go).
The full check runs this package in its E2E phase, independently of production
coverage; `go test ./...` also discovers it. Run `bash scripts/check.sh --e2e`
for only this suite, including Web, UniAuth and installed CLI preparation. With
`scripts/env.sh` sourced and PostgreSQL, the UniAuth fixture and
`DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT` already prepared, its direct entrypoint is
`go test -race -count=1 -timeout=10m ./cmd/e2e_tests`. The normal real-UniAuth fixture supplies
sessions/PATs and explicit membership;
installed commands use private origin-matched PAT configuration. Authentication
and authorization remain on the production resource path. The E2E package's
`TestMain` freshly builds a race-enabled server, starts only owned loopback
children against isolated real PostgreSQL schemas, and checks HTTP workflows, restart persistence, competing
mutations, PR string/NUL/order/duplicate persistence, partial-write rollback,
cancellation, graceful/forced SIGTERM,
migration failures and simultaneous startup. This signal acceptance runs in the
Ubuntu Go E2E CI job. Independent scenario subtests run with at most four concurrent
slots within their sequential top-level test; each retains its own schema,
processes, database barriers and cleanup. This keeps other top-level tests'
process-wide environment changes outside the parallel scenario lifetime.
Existing three-platform CLI validation remains separate.

Direct tests of `main`, `run` and command-internal migration behavior remain in
`cmd/daynight-server`. They own their temporary storage and lightweight helpers,
so selecting that package does not invoke the E2E binary build, source checks or
receipt initialization. Its integration tests still require PostgreSQL and the
UniAuth fixture. With `scripts/env.sh` sourced and those inputs prepared, run
`go test -race -timeout 10m ./cmd/daynight-server` without an installed CLI receipt.
The [E2E package decision](../../.agents/notes/implemented/testing/2026-11-03-server-e2e-package.md)
owns this package separation, and the
[CI split decision](../../.agents/notes/implemented/testing/2026-11-04-server-e2e-ci-jobs.md)
owns independent coverage/E2E execution; the
[CI efficiency decision](../../.agents/notes/archived/testing/2026-10-21-ci-validation-efficiency.md)
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

The [binary scenarios](cmd/e2e_tests/acceptance_test.go) and their
[process/evidence harness](cmd/e2e_tests/acceptance_process_test.go) map to
the [V1–V10 requirements](../../docs/spec/daynight-server.md). The installed
Thread scenario also verifies the [discussion contract](../../docs/spec/daynight-task-thread.md):

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
| Task Thread: CLI/service contract | [`installed_cli_task_thread`](cmd/e2e_tests/acceptance_thread_cli_test.go) verifies authenticated human/Agent authors, replies and nullable snapshots, millisecond message-ID pagination, complete resource/text byte bounds, controlled refusals and unknown submissions, task immutability and owned resource cleanup |

HTTP error assertions preserve expected status/code, JSON response headers and
exact error.requestId/X-Request-ID correlation. Known secret markers and database
URLs are checked across the entire body. SQL-marker checks cover the complete
JSON envelope, including unknown fields and keys, while masking only the direct
error.requestId string after unique, syntactically valid header correlation.
Other original bytes and nested requestId fields remain diagnostic content. The [acceptance metadata decision](../../.agents/notes/archived/bug-fix/2026-10-21-http-error-acceptance-metadata.md)
explains why a legal opaque ID may contain the SQL marker.

The installed CLI project/task scenario and its artifact/source validation live
in [`acceptance_cli_test.go`](cmd/e2e_tests/acceptance_cli_test.go). Its
mixed unfinished/completed fixture verifies the exact default and `--all` list
membership and order. Each JSON array equals the complete task resources after
removing only `description`, retaining raw PR strings, timestamps and exact int64
versions; task show retains the full description. Human lists retain identity,
status, readiness, dependencies and escaped PR references while omitting
description, version and timestamps; `task show` retains those detail fields.
Both detail and all-status list output preserve visible PR control-character
escaping without emitting raw terminal controls.

The [external-dependency write scenario](cmd/e2e_tests/acceptance_external_dependency_write_cli_test.go)
waits for the parsed `http_request` records for both successful raw PATCHes,
`external-flags-only` and `external-flags-noop`, before capturing the subsequent
CLI refusal's mutation-count baseline. Each preparation record must match its
request ID, method PATCH and status 200; an HTTP response or unrelated record
count does not establish that the test process has consumed those logs. After
the CLI exits, the existing mutation-log wait precedes the strict assertion of
exactly one additional request, status 409 and the matching stderr request ID.
The [request-log synchronization decision](../../.agents/notes/implemented/testing/2026-11-03-cli-request-log-synchronization.md)
owns this ordering rationale and its regression boundaries.

The independent [platform/status scenario](cmd/e2e_tests/acceptance_platform_cli_test.go),
`TestInstalledCLIPlatformAcceptance` / `installed_cli_platform_status_workflow`,
owns a separate PostgreSQL fixture, installed CLI workspace and server process.
It checks all four required-platform values across nine status pairs, exact +0/+1,
platform and material preservation, compatibility-filtered candidates, explicit
clear, stale/no-op behavior and in-progress platform refusals. It requires graceful
SIGTERM exit 0 and the fixture's normal cleanup receipt. The project/task
workflow retains its assertions. Each scenario owns its server until cleanup,
with a process context derived from `context.Background`, bounded by the owning
Go test's deadline and cancelled by fixture cleanup. A bounded test timeout is
required; startup, request, CLI-operation and shutdown bounds remain independent. Runtime
success remains established by source-bound acceptance receipts, separately
from this scenario inventory.

The [attachment scenario](cmd/e2e_tests/acceptance_attachment_cli_test.go)
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
The [combined acceptance decision](../../.agents/notes/archived/testing/2026-10-21-task-attachment-cross-layer-acceptance.md)
records the original choices for this proof and the same-data CLI/browser journeys.

The [status scenarios](cmd/e2e_tests/acceptance_lifecycle_cli_test.go)
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

The Node orchestrator reuses that installation for two deadline probes after
the Go coverage gate. They load a test-only preload with 1-second request and
3-second operation deadlines, while separately asserting the installed production
defaults of 30 seconds and five minutes. Their `deadlines` records `totalMs`,
`requestMs` and whether it was mocked in the root
`.tmp/project-task-service-evidence.json` receipt.

The explicit local `bash scripts/check.sh --stress-budgets` command retains the
same setup and Go coverage gate, then selects the four decoded-byte probes using
the unchanged 128 MiB/256 MiB defaults and exact-limit/+1-byte pairs. It writes
`.tmp/project-task-stress-evidence.json`; the script and raw probe entrypoints
refuse CI before stress setup. The CLI package's `pnpm test:stress:budgets` and
repository-root command of the same name forward to this entrypoint. Successful package-level
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
