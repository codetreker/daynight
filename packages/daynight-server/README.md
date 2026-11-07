# daynight-server

The Go service owns PostgreSQL-backed project and task management. Its runtime
foundation is implemented: explicit database and file-storage configuration,
loopback-only HTTP binding, connection validation, structured request logs, cancellation, and bounded
HTTP shutdown. Versioned migrations and transactional storage are implemented;
project/task APIs are implemented. The current
executable serves Team lifecycle, project, task, task-chain graph, task-summary synchronization
and account-owned Worker snapshot/configuration routes together with the embedded task dashboard.
Generic bucket/path local storage, task attachment
metadata and file/preview HTTP endpoints are implemented. Attachment addresses
are grouped by project and the first two canonical task UUID characters; an
explicit offline maintenance command migrates the old task-only layout.
New and replaced attachments are limited to 5 MiB of actual content; a larger
stream returns `payload_too_large` before publication. REST upload reads have a
60-second socket deadline. Active upload I/O is limited per instance, user and
Task, with immediate `resource_busy` refusal; idle MCP tickets use the separate
private transfer ledger. The [attachment contract](../../docs/spec/daynight-task-attachments.md)
and [design](../../docs/design/daynight-task-attachments.md) define the limits,
publication facts and retained failure semantics.
Dependency rows also
persist an ordinary/external classification and task/graph reads expose the
required external subset. Public create and versioned PATCH accept explicit
classification while preserving all-edge execution and project authorization.

## Assistants

The runtime composes Bot management with the same Store, file storage and
Session relay used by existing sessions. `/api/v1/me/bots` exposes authenticated,
account-owned definitions and defaults without requiring a Project. Worker Bot
registration, grants, startup reports and deletion receipts use the bound
Worker's normal PAT; Controller relay credentials do not authorize those writes.
The [assistant contract](../../docs/spec/assistant.md) defines exact endpoints,
version strings, idempotency, observed availability and failure responses.

A name-only create resolves a fresh compatible Worker report and freezes its
configuration. Older Workers without `assistantHost` remain unsupported, even
when online. A pending definition does not prove native startup; the relay checks
actual synchronization before committing successful preferences. Bot sessions
retain independent Session protocol identities and are excluded from ordinary
Test lists. Existing Task and standalone Test paths remain separate.

Deletion commits a persistent access barrier before cleanup. Completed requires
both the bound Worker's verified stop/private-file receipt and successful server
history cleanup. The server removes Bot-associated Session rows, content and its
restricted archive namespace, preserving minimal deletion responsibility. It does
not delete independently created tasks, ordinary working directories or
Provider-owned native history. There is no deleted-assistant archive entry.
The [design](../../docs/design/assistant.md) owns lock ordering, identity checks
and reconciliation after uncertain writes.

Hosting depends on the foreground Worker remaining online; this service does not
install an OS daemon, migrate conversations automatically or provide Webhook/MCP
adapters. CLI/Server and production-page browser acceptance are distinct from
live Provider acceptance.

## Webhooks

Task, Step and Thread writes capture eligible notification responsibilities in
their source transactions. The application exposes authenticated management,
history and redelivery routes and starts the sender and retention workers after
composition. `DAYNIGHT_WEBHOOK_ENABLED` defaults to `0`: existing subscriptions
continue to capture, but new or expanded configuration and network claims are
refused; authorized reads and restrictive cleanup remain available. Recovery and
retention continue. The [runtime design](../../docs/design/webhook-runtime.md)
contains deployment, rollback and recovery procedures. The [capture](../../docs/design/webhook-capture.md),
[delivery](../../docs/design/webhook-delivery.md), [retention](../../docs/design/webhook-retention.md)
and [key maintenance](../../docs/design/webhook-key-maintenance.md) designs own
their respective data and transaction rules.

## Contracts

The [requirements](../../docs/spec/daynight-server.md) own observable behavior and
the [design](../../docs/design/daynight-server.md) owns architecture and concurrency.
Read the [organization rules](../../docs/daynight-server.md) before adding to,
modifying, or reviewing daynight-server.
The TypeScript review command retains its separate configuration, storage and
lifecycle. The client HTTP foundation targets this service's API.

The [candidate input limits](../../docs/spec/daynight-api-input-limits.md) and
[measurement design](../../docs/design/daynight-api-input-limits.md) describe
pure domain admission, protocol measurement, and the active HTTP input limits.
Domain online admission is owned by each respective implementation.

The [assignment contract](../../docs/spec/daynight-task-assignment.md) and
[design](../../docs/design/daynight-task-assignment.md) define the native nullable
Task assignee. Ordinary task creation/PATCH and full Task, summary and graph
producers carry it. Native assignee filtering and project-scoped people reads
are implemented. The Web consumes assignment with independent persistent profile
content, strict task parsing, people presentation, mutation and local list filters. The CLI consumes the required
nullable field and supports assignment/clearing, current-ID output and explicit
list filters.

The [authentication requirements](../../docs/spec/daynight-auth.md) and
[architecture](../../docs/design/daynight-auth.md) define UniAuth identity
handoff, local users, browser sessions, personal access tokens and project
membership. The identity module implements persistent users, browser-bound login
transactions, sessions, PATs and callable HTTP handlers;
NewIdentity/NewAuthentication/RegisterRoutes are composed by the runtime. The
[identity admission](../../docs/design/daynight-auth.md#uniauth-一次性交接) limits the
decompressed upstream response to 2 MiB and retains the 15-second deadline. It
checks the external ID, name and email at 1024 UTF-8 bytes each, the avatar URL
at 512 KiB, and the complete normalized profile JSON at 1 MiB. Invalid or
oversized upstream identity returns 502 `identity_unavailable` without changing
the user, Personal Team or session; the already consumed login remains consumed.
Nullable values and data URLs are preserved without truncation.
The membership module provides NewMemberships/NewMembershipRoutes, transaction-scoped
access checks, private project creation, filtered project lists, administrator
changes and invitations. The
[identity foundation](../../.agents/notes/archived/architecture/2026-10-22-identity-credentials.md)
and [membership foundation](../../.agents/notes/archived/architecture/2026-10-22-project-membership.md)
record the original separation and its rationale.
GET/HEAD `/api/v1/me` authenticates and reads the current user before comparing a
strong ETag over the complete identity-bound JSON representation. Successful
responses use `Cache-Control: private, no-cache`; an unchanged validator receives
a bodyless 304, while a changed profile/account receives 200. HEAD omits the body.
Authentication and user-read failures retain no-store errors and cannot return
304. The Web overrides its usual no-store fetch policy only for `/me`, allowing
browser-managed revalidation across reloads without a custom identity store.
Stored `ProjectGrant` facts and their real observation versions are distinct from
computed `ProjectAccess`. The authenticated
`GET /api/v1/projects/{projectId}/access` returns required projectId, ownerTeam,
ownership, effectiveRole, teamRole, directGrant and canTransfer. TeamRef has an
id, personal/ordinary kind and a nullable raw name; Personal names are null.
Ownership contains the real teamId and positive int64 JSON-number version.
A present grant contains its project/user IDs, stored role, exact version and
UTC creation/update times. teamRole is null/member/admin; canTransfer is true
only for an owner Team admin. Inherited-only admission has a null grant; failed
admission remains an error. The endpoint returns no member profiles, accepts no
query parameters, supports GET/HEAD and preserves the principal response header
and no-store policy. Resource admission and accessible-project filtering use
the canonical relation that computes the maximum of owner Team and direct-grant
roles under `none < member < admin`. GET project members returns
`{items: ProjectParticipant[], actorAccess: ProjectAccess}` from one snapshot.
Each participant has userId, a required profile object (nullable name, email and
avatarUrl), effectiveRole, nullable inheritedFrom:{team:TeamRef,role} and nullable
directGrant. The Web publishes actorAccess through its existing identity,
project and observation fences before using the roster for management.
Raw owner-Team and grant candidates survive the canonical-user LEFT JOIN;
missing user rows fail the whole roster instead of disappearing. Inherited-only
participants have a null grant, while any direct grant retains its own real
role, version and timestamps. Legacy role PATCH requires `expectedUserId`, stored role and the exact
grant version, and returns `ProjectGrant`; DELETE requires the actor and version
and retains 204. `PUT /api/v1/projects/{projectId}/grants/{userId}` accepts
`{version:null|positive int64,role,expectedUserId}`: null requires no existing
grant, while a positive version must match the stored grant. A new grant target
must already have effective Project access. The 200 response contains `grant`
and nullable `actorAccess`. DELETE on the same path accepts a positive version
and expectedUserId and returns `{projectId,userId,deleted:true,actorAccess}`.
The access projection reflects the actor after the mutation in the transaction;
null means the confirmed operation removed their access. Effective admins may
manage their own and other admins' grants, including the last direct admin.
Mismatched existence/version returns 409 `version_conflict`; a target without
Project access returns 404 `not_found`. The actor guard precedes domain SQL and
reports 409 `identity_mismatch`. A commit whose result cannot be confirmed
returns 503 `write_outcome_unknown`; a later read establishes current facts, not
the original outcome, and callers must not automatically replay the write.
Invitation inspection returns the current direct grant and effective access; acceptance
returns the real grant, post-write access and joined/consumed flags. Create, revoke
and accept bind `expectedUserId` before domain SQL.
Worker administrator checks consume access, while claim ownership and acquisition
assignment requirements retain their separate rules.
The project settings API provides a versioned execution-warning threshold that
administrators save and members read.
The application mux mounts all of these modules and requires authentication for
every project, task, graph, attachment and Worker route. The production Web entry separates
the public introduction at `/`, the zero-API guide at `/setup`, and the existing
`AuthenticatedApp` lifecycle for `/login`, `/projects` and private pages.
`daynight login` uses Daynight device authorization to obtain
a nonexpiring `Daynight CLI (<hostname>)` Bearer credential named for the initiating machine. Explicit PAT configuration remains
available for automation. Every user has one Personal Team with a real owner
admin. Every Project has a real ownership row; existing projects migrate to the
Personal Team of the earliest-joined current administrator. A missing current
admin or invalid reference stops migration. Trusted executable
HTML retains its application origin, relative resources and keyboard behavior.
The [activation decision](../../.agents/notes/archived/architecture/2026-10-22-authentication-activation.md) records the rationale for composition and credential-private validation; current delivery results
require receipts bound to the tested source.

The [project Task search requirements](../../docs/spec/daynight-task-search.md)
and [design](../../docs/design/daynight-task-search.md) define the read-only
`POST /api/v1/projects/{projectId}/tasks/search` endpoint. It searches complete
titles and Markdown descriptions using literal expressions, returns ranked
pages with real ordinary-dependency context, and rejects continuation when the
project Task fence changes. [HTTP fixtures](testdata/task-search/README.md)
include successful pages and typed failures.

The [task-summary synchronization requirements](../../docs/spec/daynight-task-sync.md)
and [architecture](../../docs/design/daynight-task-sync.md) define the implemented
`GET /api/v1/projects/{projectId}/task-sync` endpoint. It returns a complete summary
snapshot or current records whose `updatedAt` is at least the supplied task
watermark minus `DAYNIGHT_TASK_SYNC_OVERLAP` (default `10s`). Task versions use
exact decimal strings; each intrinsic summary includes explicit nullable
assignedTo and the complete current properties object, while descriptions,
derived blockers and readiness remain outside these summaries. Task rows and batched property rows share one
repeatable-read snapshot. Every snapshot and delta, including an empty delta,
also returns required top-level `actorAccess` using the access endpoint's DTO and
complete `assigneeVersions` entries `{userId,version,hasProjectAccess}` for the
qualified people catalogue. The existing admission result supplies access in the
same snapshot; its nested ownership and grant versions remain exact int64 JSON numbers.
People metadata contains no names or avatars, is UUID-sorted and distinct, and
uses the same qualification and content versions as task-assignees. Any profile
query, integrity or transaction failure fails the whole sync. Hashing reads all
qualified profile content on each sync, costing O(people + total profile bytes);
manifest transport is O(people). It introduces no PostgreSQL migration. Browser consumers publish access only
to the current identity/project memory owner, outside persistent Project and Task
records. Missing keys propagate removal through whole-summary
replacement; ordinary property changes preserve the epoch. Invalid stored
properties fail the complete request with 400 invalid_input. Database and
transaction-completion faults remain 500 internal_error and take precedence over
a saved property validation refusal. A stored project epoch invalidates caches after supported
history replacement and transactional task soft deletion. The Web persists
summaries and details and replaces them atomically after an epoch change. Its schema-9 upgrade explicitly rebuilds incompatible task caches for required
cancelledAt while preserving separate profiles and compatible Session history.
The historical schema-6 upgrade added profiles while retaining schema-5 task
data, Project ownership and user fences. Upgrades from versions 1,
2, 3 or 4 still rebuild incompatible project, summary and detail stores, rotate
user fences and clear old watermarks before a complete snapshot. Profile content is reusable after reload
only after current identity/project admission and version matching; access stays
in the live manifest. Ordinary task epoch replacement can retain matching profile
content while all publication remains generation-fenced. Missing properties, assignedTo or Project ownership in old records cannot
receive defaults. Graph nodes omit properties,
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

Task Session reads require current project access; execution interactions require
the authenticated actor to match the persisted Session owner. Project and Team
administrators receive the same read-only access as other non-owner members.
Admission, dispatch, reconnection reconciliation and terminal lease/ACK checks
apply this rule without changing the wire format or Controller ownership.

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
| `internal/server/` | API/UI routing, HTTP lifecycle, request context, request IDs, structured logs |
| `internal/service/webui/` | Embedded production HTML/assets and resource reads |
| `internal/server/webui/` | Static routes and HTTP response policy |
| `internal/core/store/` | Database-neutral DAO, scope and transaction contracts |
| `internal/core/store/postgres/` | PostgreSQL implementation, migrations, scoped writes and consistent reads |
| `internal/core/filestorage/` | Generic bucket/path byte operations and address validation |
| `internal/core/filestorage/local/` | Root-confined local files, complete-file replacement and root lifecycle |
| `api/` | Project/task/attachment, identity and membership DTOs; common HTTP error envelopes |
| `internal/service/` | Project/task use cases, identity/credentials, project membership/invitations, state/version policy and scoped cursors |
| `internal/core/model/` | Shared project/task, identity/member models and resource-not-found markers |

Startup validates neutral configuration and constructs the UniAuth client before
opening one local file root and one PostgreSQL resource. `service.App` assembles
and owns the shared modules and resources; `server.New` registers their HTTP
routes. The runtime stops admission and drains HTTP and WebSocket work before
the application closes the Session engine, files and pool. A cleanup timeout
retains resources for another close attempt. Startup validates the embedded
format snapshot and prepares the target PostgreSQL schema before accepting
requests. One pinned connection holds the migration advisory lock while
inspecting the target namespace and initializing or upgrading its format.

An empty namespace receives the current snapshot, required initial rows and the
complete original migration-checksum ledger in one transaction. Historical SQL
and Go transforms do not execute on that path. SQL, initial-data, ledger and
deferred-constraint commit failures roll back the complete initialization. A
lost commit acknowledgment preserves an unknown outcome and the original error;
initialization remains all-or-nothing, and the next startup inspects the actual
namespace and ledger. A namespace containing user objects follows the existing
ordered migration path, even when it has no
migration ledger; objects in another schema do not affect that choice. Unknown
versions, gaps and checksum mismatches stop startup. Reopening an initialized
schema preserves its existing data and ledger timestamps. The
[initialization decision](../../.agents/notes/implemented/architecture/2026-11-06-postgres-schema-bootstrap.md)
owns the namespace, transaction and concurrency guarantees.

Migration `032_personal_project_ownership.sql` creates the Personal Team/member
and Project ownership records and renames the existing member table, sequence,
constraints and index to grant names in place. Grant rows, timestamps, versions,
and sequence `last_value/is_called` survive, including allocated versions whose
rows were deleted. All existing users, including PAT-only users, receive Personal
Teams. Zero-admin projects and invalid references fail the whole transaction;
SQL, transform and migration-ledger failures roll back together. The
[auth architecture](../../docs/design/daynight-auth.md#数据与并发) owns the exact
backfill and integrity rules.

Stop old application and direct writers and retain a paired database/file backup
before this schema transition. The migrator lock coordinates migrators, not old
writers. Start the matching application after migration; old binaries do not
understand the renamed grants or inherited authority. After a committed migration,
recovery requires forward repair or restoration of the paired backup while
writers remain stopped, with its corresponding loss of later writes.

## MCP HTTP entry

The stateless `/mcp` endpoint supports Streamable HTTP protocol versions
`2026-07-28` and `2025-11-25`. Configure a client with the service's HTTPS URL
ending in `/mcp` and an `Authorization: Bearer <PAT>` header. The entry also
accepts MCP OAuth access credentials for its exact resource and `daynight:mcp`
scope. Standard clients can discover the OAuth authorization server from the
unauthenticated challenge and authorize through the existing browser account.
Each request validates its own credential; browser cookies are not accepted. Requests carrying
an Origin must match `DAYNIGHT_PUBLIC_ORIGIN` or an explicitly configured origin.
The [OAuth requirements](../../docs/spec/daynight-mcp-oauth.md) and
[architecture](../../docs/design/daynight-mcp-oauth.md) describe the browser
journey and protocol composition.
The endpoint advertises Team lifecycle, membership and scoped Project tools,
Project creation, transfer, listing and inspection,
Team invitation creation, listing and revocation, inspection and acceptance of
Team or Project invitations, Bot management, Task creation, reading, updating,
status, deletion, property, list, ready and graph tools, ordered Task Steps reads
and writes, Task discussion reads and posts, and attachment listing, removal,
bounded reads and inline or resumable upload. The [attachment design](../../docs/design/daynight-task-attachments.md)
owns upload admission and transfer behavior. Attachment open creates a private immutable snapshot for ranged
reads; each request rechecks access. Inspection returns metadata by default,
explicit reads default to 8 KiB, and binary content requires base64 selection.
Inspect and open results are limited to 16 KiB; exceptionally oversized MIME or
paths are rejected explicitly. Close and expiry reclaim only the private snapshot.
Invitation links are returned
only by creation; listing returns metadata without secrets. Task mutation inputs
use the existing 1 MiB business JSON limit; versions are decimal strings and
property values use `valueText`. Task and Step reads default to marked
summaries; request `full` for complete content. Step page cursors bind the parent
version and reject
continuation after a change. Step writes return confirmed version and change facts
and preserve the original collection capacity. Discussion reads return complete
messages in oldest-first order; an explicit claim ID supplies agent attribution.
A lost post response does not establish a receipt: read the thread before
deciding whether to send again. Bot creation resolves omitted settings from
available Worker defaults and does not imply startup readiness. Bot deletion
requires an explicit version and reports the separate Worker and server cleanup
states. Team and membership versions are decimal strings, and list results use
scoped cursors. An item in a Team, Team member or scoped Project list that
exceeds its response budget produces an explicit error; complete MCP retrieval
and continuation past that item are not yet available.

Task list excludes done tasks by default and orders in-progress, ready, blocked
and done tasks before paging. Its cursor binds the caller, project, filters and
view to a snapshot fence; `list_changed` requires restarting traversal when
project task versions change. Graphs retain their node and edge limits.

`task_ready` returns the first matching ready Tasks ordered by creation time and
UUID. Its `limit` defaults to 5 and accepts 1 through 20; permission and platform
filters apply before the limit. Each call reads the current first batch without
pagination. The result contains `items` and `projection`, with no `nextCursor` or
`next` continuation. It does not calculate a response byte budget or shorten the
batch based on encoded size. The default `summary` contains marked title previews
and selection fields; `view: full` returns complete Tasks, including descriptions
and properties. The shared MCP response limit and resource admission still apply.
To traverse all ready tasks, use `task_list` with `ready: true`; its full list
projection omits descriptions. Read current complete Tasks separately through
`task_show` with `view: full`. These separate reads do not share the list's fence.

OAuth grant families store only hashes of access and refresh secrets. Initial
issuance and revocation participate in the caller's transaction; access lasts at
most one hour and the grant and refresh at most 30 days. The principal carries
the access credential ID, while the stable authority reference carries the grant
ID. Revocation invalidates access rows in the same transaction, and Thread and
Bot credential checks recheck expiry after lock waits. OAuth credentials do not
authenticate ordinary REST or private Worker endpoints.

The OAuth public profile supports browser-bound requests, account-checked
decisions and one-time S256 code exchange. A valid
exchange consumes the code and issues its credential family in one transaction;
a correctly bound replay revokes that family. Incorrect bindings leave the code
usable. Decision and token responses cannot be recovered after loss: inspect the
request state and start a new authorization when necessary. Approval alone does
not confirm that the client received the code or connected.

The request body limit is 4 MiB. Operations that may materialize large objects
reserve a single 512 MiB working slot before calling a use case; bounded control
operations have a separate 16-slot budget. A saturated budget returns
`resource_busy`. Attachment inspection and new download snapshots use a separate
four-slot content budget; repeated open and transfer control calls remain on the
control budget. A new open releases its control slot only after acquiring a content
slot. Permits remain held until the handler and response delivery finish. The
opt-in `TestStressMCPStepsCapacityAndConcurrentSummaryHeap` verifies
the 64 MiB Step collection and concurrent summary write admission with sampled
Go heap. After preparing the isolated database and UniAuth fixture, run it
separately from CI:

```bash
go test -race -tags=stress ./internal/server -run '^TestStressMCPStepsCapacityAndConcurrentSummaryHeap$' -count=1 -timeout=10m
```

The application stops webhook claims and rejects new HTTP work before draining
requests and the Session relay. HTTP, Sessions, webhook attempts, maintenance
and dependency release share the shutdown budget. On timeout it cancels work,
retains dependencies still in use and returns an error; a caller can retry close.

## Local Docker deployment

Configure the required UniAuth App and origin settings using the
[deployment guide](../../deployment/localhost/README.md), then run
`bash deployment/localhost/up.sh` from the repository root to build and start the
dashboard and API with PostgreSQL and wait for readiness. Only Docker is required
on the host; valid authentication settings remain mandatory. The [deployment guide](../../deployment/localhost/README.md) owns
prerequisites, API examples, port selection and persistence/teardown commands.
The gateway publishes host `127.0.0.1:8787` and forwards TCP to the server's
loopback listener in their shared network namespace; the database has no
published host port. Startup initializes or upgrades the database with this
module's embedded format snapshot and migrations. Open
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
publishes it to `internal/service/webui/dist/`. Generated files are ignored by Git; a
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
| `DAYNIGHT_WEBHOOK_ENABLED` | Permit webhook configuration expansion and network claims (`0` or `1`) | `0` |
| `DAYNIGHT_WEBHOOK_KEYRING_FILE` | Private keyring file; required when enabled or retained ciphertext needs a key | Empty |
| `DAYNIGHT_STORAGE_ROOT` | Writable local storage directory; case-sensitive on Linux, ordinary directories supported for native macOS development | Required |
| `DAYNIGHT_PUBLIC_ORIGIN` | Exact main-site origin, HTTPS in production | Required |
| `DAYNIGHT_MCP_ALLOWED_ORIGINS` | Comma-separated exact browser origins additionally permitted for MCP requests | Only `DAYNIGHT_PUBLIC_ORIGIN` |
| `DAYNIGHT_OAUTH_PREREGISTERED_CLIENTS` | JSON object mapping client IDs to public client metadata documents with matching `client_id` | Empty |
| `DAYNIGHT_MCP_TEMP_BUDGET_BYTES` | Positive decimal byte budget shared by private MCP transfer content across instances | `8589934592` (8 GiB) |
| `DAYNIGHT_MCP_RESERVED_FREE_BYTES` | Nonnegative decimal bytes kept available for ordinary storage when reserving transfer capacity | `1073741824` (1 GiB) |
| `DAYNIGHT_UNIAUTH_URL` | UniAuth gateway origin | Required |
| `DAYNIGHT_UNIAUTH_APP_ID` | Registered UniAuth backend App ID | Required |
| `DAYNIGHT_UNIAUTH_APP_SECRET` | Server-only UniAuth App secret | Required |
| `DAYNIGHT_UNIAUTH_CALLBACK_URL` | Exact same-origin callback URL with a canonical non-root path and no query/fragment | Required |
| `DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN` | Explicit main-site HTTP test-origin policy (`0` or `1`) | `0` |
| `DAYNIGHT_ALLOW_LOOPBACK_HTTP` | Separate SDK permission for a literal loopback UniAuth HTTP gateway (`0` or `1`) | `0` |
| `DAYNIGHT_LISTEN_ADDR` | Numeric loopback IP and port, including IPv6 syntax | `127.0.0.1:8787` |
| `DAYNIGHT_STARTUP_TIMEOUT` | Positive Go duration for database connection and listener startup | `10s` |
| `DAYNIGHT_SHUTDOWN_TIMEOUT` | Shared positive shutdown duration, at most 10 seconds | `10s` |
| `DAYNIGHT_TASK_SYNC_OVERLAP` | Positive Go duration subtracted from a supplied task-summary watermark | `10s` |

Wildcard, non-loopback, hostname, scoped IPv6, and malformed listen addresses are
rejected. Callback paths that collide with application routes are rejected during
configuration and startup validation before route registration; this includes
`/mcp`, `/login`, `/setup`, `/teams` and every descendant path, together with the
`/api/v1/teams` API namespace and `/api/v1/webhook-event-types`. If an existing callback occupies that
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
PostgreSQL and webhook worker failures, but does not establish UniAuth
connectivity or login success.
Port `0` requests an ephemeral loopback port; the bound address appears
in the startup log. Invalid timeout values fail validation.

`SIGINT` and `SIGTERM` stop accepting connections and begin draining requests.
Active REST request contexts remain usable during the drain; MCP requests are
canceled when shutdown begins. On deadline, the runtime cancels remaining request
contexts, signals Session operations and force-closes HTTP connections. It waits
up to five additional seconds for active handlers, relay and session work, and
database cancellation before closing the file root and pool. The timeout remains
an error; if cleanup is incomplete, ownership is retained for another close
attempt. Database operations must
use the request context and release acquired connections.
The runtime also closes an acquired file root on later startup failure. Local
files remain on disk when the handle closes. Tests use isolated storage roots.

Logs use JSON `slog` records with type, component, phase, and request ID. HTTP
records include method, route template, status, and duration. A supplied
`X-Request-ID` must contain 1–64 ASCII letters/digits with optional `.`, `_`, or
`-` after the first character; invalid or absent values receive a generated ID.
The response returns `X-Request-ID`. Successfully authenticated handlers also
return `Daynight-User-ID` from the admitted principal, including empty mutations
and later resource errors. Failed authentication does not emit that header;
caller-supplied values are not echoed. An unmatched route has an empty route template.
UI and API requests use the same logging wrapper. Exact `/device`, `/account`,
`/invitations`, `/team-invitations`, `/`, `/login`, `/projects`, `/workers`, `/workers/{workerId}`, `/setup`,
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

The check builds and vets the Go module using its unit-test Web resource overlay,
prepares the pinned UniAuth fixture, and runs module tests and coverage. The
optional `--coverage` argument selects the same check. A production build uses
the real Web assets described under [Build and run](#build-and-run).

### Business rules and DAO mocks

Business-rule unit tests construct domain facts directly and use narrow mocks
of the `core/store` DAO interfaces when a rule needs query results or storage
errors. Check arguments, expected calls, results and error chains; unconfigured
access must fail immediately. Pure functions need no storage mock. Keep these
rule selections runnable without `DAYNIGHT_TEST_DATABASE_URL`, rather than
preparing PostgreSQL merely to obtain fixed model data.

PostgreSQL integration tests own real SQL, constraints, locking, commit and
rollback, persisted readback and authority or version changes across operations.
HTTP and process tests retain their composition and protocol boundaries. Moving
a rule matrix does not remove these proofs or replace them with a single mock
call. Do not mock SQL strings or implement a second in-memory database to test
business rules.

The Session control catalog, activity and argument rules call the authorization
function with ordinary Task facts, a matching active Worker and fence, and a
controlled clock. Positive commands establish that the fixture admits valid
inputs. Real Submit/outsider, durable operation and offer/dispatch recheck tests
retain the storage boundary. The
[control-rule decision](../../.agents/notes/implemented/testing/2026-11-06-session-control-rule-isolation.md)
records the proof split. The [server organization rules](../../docs/daynight-server.md#测试职责)
own the stable test-layer policy.

Session command and interaction admission tests use `SessionDAO` query mocks
that check context, identity arguments, call counts and error propagation.
Ordinary Task rules and independent Test Session first-input rules keep separate
fixtures. A real timeline-upsert, Submit, operation-readback and duplicate-callback
witness retains the persisted interaction-ID mapping. The
[command-rule decision](../../.agents/notes/implemented/testing/2026-11-06-session-command-rule-isolation.md)
records that split.

Session load-state tests control `LockSession` through its DAO interface and
observe local live-state and pending-content behavior for valid bindings,
mismatches, missing records and operational errors. Actual row deletion, DAO
missing-row mapping and Bot deletion/revocation barriers retain PostgreSQL. The
[load-state decision](../../.agents/notes/implemented/testing/2026-11-06-session-load-state-isolation.md)
records the error and invalidation expectations.

Bot registration preflight tests use valid frozen-role, configuration and
registration facts with the existing runner boundary. Invalid inputs must never
enter the runner, and a valid-input sentinel proves the fixture can reach it.
The PG frozen-configuration test first verifies an invalid registration created
no Session or binding changes, then retains its real authority and version
checks. The [Bot preflight decision](../../.agents/notes/implemented/testing/2026-11-06-bot-registration-preflight-isolation.md)
records the shared-fixture and no-partial-write guarantees.

Project request validation uses a valid synthetic principal and a fail-on-access
store for UUID, creation input, pagination and entropy refusals that precede
storage. Real creation, readback, keyset paging and operational-error tests keep
PostgreSQL. The [Project validation decision](../../.agents/notes/implemented/testing/2026-11-06-project-request-validation-isolation.md)
records the input and error-chain guarantees.

Task request tests separate service preflight from candidates that require a
stored Task. Preflight rejects before storage; `PrepareUpdate` and `PrepareStatus`
tests use `TaskWriteDAO` expectations for reads, version order, results and error
chains. Real scope, refusal-without-mutation, graph, rollback, concurrency and
all-status-pair/version observations remain PostgreSQL integration proofs. The
[Task validation decision](../../.agents/notes/implemented/testing/2026-11-06-task-request-candidate-isolation.md)
records the read-before-validation distinction.

Attachment migration manifest, stage, receipt, path and inventory tests use a
fixed `AttachmentMaintenance` snapshot with real temporary files and the real
migration runner. Database-shape validation, command/root failures, maintenance
queries and process crash recovery retain their PostgreSQL boundaries. The
[record-validation decision](../../.agents/notes/implemented/testing/2026-11-06-attachment-record-validation-isolation.md)
records which storage facts are mocked and which durable operations remain real.

### TaskSync lock and time windows

TaskSync lock-wait regressions use a named 20-millisecond test overlap with real
PostgreSQL transactions. After observing the blocked writer, they poll the
database clock with a bounded deadline until that overlap has elapsed before
releasing the Project lock. The old snapshot must retain committed versions
while its observation time crosses the uncommitted write's window; subsequent
delta reads must include both committed writes in timestamp order. Initial
fixture rows share a database timestamp so setup latency cannot exclude either
row from the short baseline window.

The production overlap and the independent 10-second, 30-second and nanosecond
window cases remain separate. The [timing decision](../../.agents/notes/implemented/testing/2026-11-06-task-sync-lock-window.md)
records why database clocks and lock observations are required together.

### HTTP scenario ownership

Domain packages own their HTTP integration scenarios, including those that
construct the production application and use real PostgreSQL and UniAuth
fixtures. The root `internal/server` package retains tests that need internal
composition access, shared startup/channel fixtures and runtime shutdown
ordering. Shared scenarios run once in their domain owner; internal-only
assertions remain in the root package. The
[HTTP test ownership decision](../../.agents/notes/implemented/testing/2026-11-06-server-http-proof-owners.md)
records the distinction and preservation requirements.

The Session browser ping regression uses production Session routes with real
business services and authentication in a focused route fixture. Its test-local
interval allows actual Ping/Pong and subsequent event delivery to complete
promptly. Other integration scenarios retain the full application. Route
cleanup drains the relay and stops its engine before the outer fixture releases
its borrowed Store and files. The
[Session test completion decision](../../.agents/notes/implemented/testing/2026-11-07-session-protocol-test-completion.md)
records this fixture's responsibility.

The domain Session fixtures share application shutdown cleanup and mutable
error expectations. Tests that deliberately revoke authority may declare the
exact clean domain fault caused by that transition. Project deletion channel
tests declare `not_found` after successful deletion because socket closure can
precede the server's disconnect cleanup. Every joined cause must match the
selected fault without an underlying cause; database errors, timeouts and other
faults still fail cleanup. Production shutdown error handling remains unchanged.
The [shutdown expectation decision](../../.agents/notes/implemented/testing/2026-11-07-session-deletion-shutdown-expectations.md)
records the timing and error-preservation rationale.

### Schema snapshot maintenance

`internal/core/store/postgres/schema/current.sql` records the final PostgreSQL
format produced by the complete embedded migration history. It includes the
migration-ledger table definition, required initial rows and sequence state;
it does not freeze migration-ledger rows or their application timestamps.
Runtime startup uses the snapshot for an empty target namespace and retains
historical migrations for existing namespaces. A stale snapshot version stops
startup before initialization or upgrade, exposing an incomplete format update.

The ordinary module check compares a fresh historical database with a fresh
snapshot database through PostgreSQL catalogs and initial table data. It checks
visible column order, types, defaults, nullability, constraints, indexes,
sequence definitions, ownership and state, and the routines, views and triggers
present in the format. Only instance identifiers and schema qualification are
normalized. The snapshot version must match the latest migration, so every
migration change requires refreshing and verifying the snapshot.

Regenerate from a fresh historical schema with a PostgreSQL 18 `pg_dump` client:

```bash
source scripts/env.sh
export DAYNIGHT_TEST_DATABASE_URL='postgres://daynight:daynight-test@127.0.0.1:PORT/daynight?sslmode=disable'
go test -count=1 ./internal/core/store/postgres \
  -run '^TestSchemaSnapshotMatchesMigrations$' \
  -args -update-schema-snapshot -schema-snapshot-pg-dump /path/to/pg_dump
```

The update flags belong to this package's test binary. Regeneration captures
final definitions and initial data, rather than concatenating historical SQL.
Routine validation needs only the configured PostgreSQL service; it does not
invoke `pg_dump`. The [snapshot decision](../../.agents/notes/implemented/testing/2026-11-06-postgres-schema-snapshot.md)
records the equivalence and maintenance requirements.

### Task Graph boundary fixtures

Graph boundary regressions retain the 1000-node backbone and 5000 dependency
references, plus independent node and edge overflow cases. Connected service
fixtures and the HTTP limit fixture run `ANALYZE tasks, task_dependencies` after
all links are loaded and before graph queries. These private tables can be queried
before autovacuum collects statistics; explicit collection gives the planner the
loaded graph's cardinality without changing its rows or snapshot assertions.
Preparation failures fail the test. Task service Graph and Sync seeds generate
their ordered edge prefix directly while preserving its original topology. The
[fixture preparation decision](../../.agents/notes/implemented/testing/2026-11-06-task-graph-fixture-statistics.md)
owns the rationale and proof boundary.

### Race instrumentation

The coverage check enables race instrumentation locally and on main CI. PR CI
runs without race and overrides an inherited `GOFLAGS=-race`.
The separate
`bash scripts/stress.sh` entry uses `-race` for local-only stress tests.
The fresh-process attachment test uses its test's race setting for the child
build and verifies it in the binary; other process tests may differ. The explicit
`testdata/testauth` fixture check is separate from the coverage run; use
`go test -race -count=1 -timeout=30s ./testdata/testauth` for its race validation.

### Coverage

`scripts/check.sh` builds the executable, runs `go vet`, clears cached Go test
results and invokes `go-cov` v0.1.4 with the checked-in configuration. Its
package and function thresholds are 85% and 80%; production packages, files and
functions are not excluded. `critical_blocks.fail` is false, so the check does
not analyze or fail on critical blocks. The raw `coverage.out` profile passes
an exact statement comparison strictly greater than 90%; exactly 90% fails.
The comparator reads the profile incrementally, deduplicating coverage blocks
without loading the entire profile into one string.
The check selects all listed production packages for `-coverpkg`, so a module
test also attributes its calls to other production packages. Tests and their
database state require the isolated PostgreSQL instance; preparation failures
fail validation. The check limits package concurrency to two: schema-isolated
fixtures still share the database-wide migration advisory lock.

`scripts/env.sh` places Go tools, caches and temporary outputs under this
module's `.tmp/`. The `verify-server` CI job uses its own PostgreSQL service,
runs the same check and uploads `coverage.out` as `daynight-server-acceptance`.
Inspect the result for the tested revision; a local result does not establish a
hosted result.

Ordinary discovery excludes stress-tagged files. With an isolated database,
`bash scripts/stress.sh` runs the explicit stress-tagged workloads with race
detection and refuses a nonempty `CI` environment.
The two-instance webhook takeover fixture uses a private deterministic capture
stream and verifies its first-slot admission before testing second-slot recovery
and late-result fencing; see the [fixture timing decision](../../.agents/notes/implemented/testing/2026-11-08-webhook-takeover-fixture.md).

Authentication integration prepares the pinned UniAuth gateway with
`scripts/prepare-uniauth-fixture.mts`. The fixture runs on loopback with
controlled external provider responses and owns its temporary resources. For
focused integration tests, source `scripts/env.sh`, set
`DAYNIGHT_TEST_DATABASE_URL`, then set `DAYNIGHT_TEST_UNIAUTH_FIXTURE` to the
output of that preparation script. The full check performs preparation itself.
The real archive upload and response socket deadlines can be checked separately
with `DAYNIGHT_TEST_ARCHIVE_DEADLINE=1 GOFLAGS="-overlay=scripts/unit-overlay.json" go test -tags=stress ./internal/server/session -run '^TestStressArchive(Upload|Send)DeadlineReleasesCapacity$' -count=1 -timeout=5m`; each test waits for the production 120-second deadline.
The shared fixture cleanup waits for process exit and reports forced termination;
an unconfirmed service, database-session or gateway exit retains dependent owned
resources. `scripts/check.sh` explicitly tests `testdata/testauth`, which `./...`
does not discover.
The real wire-loss test in
[`auth_transport_acceptance_test.go`](internal/server/auth_transport_acceptance_test.go)
checks the SDK-side connection and subsequent login recovery; controlled-provider
evidence does not establish a live human login.

## File storage

`filestorage.Storage` exposes `Put`, `Open` and `Delete` using bucket and real
relative path. LocalStorage mirrors `<root>/<bucket>/<path>` and validates
addresses before resolving them through `os.Root`. It rejects roots that cannot
distinguish case and rejects object access outside the root. `Open` returns the
size of its opened handle. Callers own the returned body and input reader.

New Session archives use `internal/core/model/sessionarchive.Namespace` for project/user
and Session UUID directories. Task Web/Herdr objects use
`session-archives/projects/<projectId>/<sessionId[:2]>/<sessionId>/<sha256>.json`;
independent Test/Bot objects use
`session-archives/users/<ownerUserId>/<sessionId[:2]>/<sessionId>/<sha256>.json`.
PostgreSQL retains the object path, length, digest and archive status or receipt.
Readers continue to open the persisted `object_path` and apply the existing
length/digest/structure checks. Existing files and metadata stay in place;
read behavior, same-hash ready upload retries and public URLs remain unchanged.
Archive uploads and content reads acquire one nonblocking slot per application
instance and one per original owner across instances sharing a storage root.
The lease spans body reading, validation, storage readback, encoding and response
sending; retained content must be closed after its last use. Upload reads and
archive response writes each have an independent 120-second socket deadline.
The [Session design](../../docs/design/task-session-protocol.md#归档操作占用)
owns the admission and lifecycle contract.

The restricted `DeleteSessionArchives` operation receives a validated Namespace
and removes that current Session directory, including unregistered objects,
while preserving same-owner/shard siblings. Old direct-directory files are
outside this physical cleanup scope and do not block it. The
[Session design](../../docs/design/task-session-protocol.md#服务端归档布局)
owns the address rule.

Writes stream through an owned temporary file and publish complete contents.
An empty internal directory can be reused as a file path; existing child files
remain conflicts. Internal namespace synchronization belongs to this storage
instance. Attachment operations additionally use a persistent, cross-process
target gate through file and metadata completion; an opened handle remains stable
after releasing it. The accepted non-atomicity issue is owned by the
[attachment requirements](../../docs/spec/daynight-task-attachments.md).

Both Compose deployments mount a project-scoped `attachment-data` volume at
`DAYNIGHT_STORAGE_ROOT=/var/lib/daynight/storage`. Fresh-volume initialization
preserves the image directory's UID/GID `10001:10001`, and the normal nonroot
server writes without a privileged startup process. Normal restart and rebuild
retain PostgreSQL metadata, attachment bytes and Session archive bodies; dev-ci
removes both owned data
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

New or replaced attachment paths are limited to 1024 Unicode code points, including separators. Existing longer paths remain readable and removable under the original transport rules.

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

`Store.WriteTeam` locks the real Team row in a `READ COMMITTED` transaction,
then rechecks the caller's current admin membership. Deletion reads ownership
with a separate nonlocking `EXISTS` statement after that lock, so it observes
commits made while waiting. A successful empty check is followed by deleting
members and Team in the same transaction. Ownership writers lock and recheck
the same Team before insertion; Team deletion does not acquire existing
Project, Task or Thread head locks. Team creation atomically stores the creator
admin membership. Captured write results are published only after confirmed
transaction completion; the [Team design](../../docs/design/daynight-auth.md#team-元数据与生命周期事务)
owns the outcome and lock-order details.

`Store.ReadSnapshot` uses read-only `REPEATABLE READ` for project/task queries and
derived readiness, with membership and resource reads in the same snapshot.
Project-list effective-access and scope filtering precedes pagination. Pages use a validated limit and optional `(createdAt, id)`
position; status/readiness filters run before keyset pagination. Page lookahead
is returned as `HasMore`; HTTP cursor encoding belongs to the API layer.

`Store.WriteWorker` is an independent `READ COMMITTED` transaction for account-owned
Worker observations. It updates only the matching Worker row, atomically preserving
server report time, telemetry and normalized task observations. It does not acquire
a project lock or mutate task ownership. Snapshot reads batch-filter saved task
references by current project membership and undeleted-task visibility. The
[Worker snapshot design](../../docs/design/daynight-worker-snapshots.md) owns this
separate storage and current-permission behavior.

The shared `model.Project` and `model.Task` models have one representation across
storage and service. Store queries report prerequisite/dependent records and
candidate reachability. The static property registry in `internal/core/model/taskproperty/`
owns native validation, normalization, schemas and read-only metadata;
`internal/core/task/properties/` applies public write policy. Generic
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
boundary and value codecs share strict object decoding in `internal/utils/jsonobject/`.
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
verify isolation. The [index assertion decision](../../.agents/notes/archived/testing/2026-10-24-schema-owned-index-assertions.md)
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
authenticated user, merging owner Team membership and direct grants. Subsequent reads preserve
saved observations while applying current access and undeleted-task filtering
to both rows and counts. Completion or reassignment
does not erase an otherwise visible historical observation. Liveness and recent
visibility do not control claims or task state.

## Worker cloud configuration

The account owns a desired configuration and a separately versioned application
observation on its existing Worker row. The [contract](../../docs/spec/daynight-worker-configuration.md)
defines exact fields and refusals; the [design](../../docs/design/daynight-worker-configuration.md)
defines row transactions and representation.

| Method | Path | Result |
|---|---|---|
| `GET, HEAD` | `/api/v1/me/workers/{workerId}/configuration` | Desired settings, observation revision and retained application results |
| `PUT` | `/api/v1/me/workers/{workerId}/configuration` | Exact-revision replacement of an initialized target |

Clients opt into configuration exchange on the report endpoint with
`Daynight-Worker-Configuration: 1`. The first valid local candidate creates an
absent target; later candidates cannot overwrite it. Target edits and machine
application reports have separate CAS revisions. Partial outcomes preserve real
applied values and closed failure metadata; a target save does not claim that
the machine applied it. Reports without the marker keep their original format.

Configuration reads do not use the snapshot recent window or renew liveness.
The authenticated account owns admission; active task claims are not a
configuration prerequisite. No task fields, acquisition constraints or recovery
semantics change. This service validates and exchanges settings; native
preparation and resource stopping remain machine-side runtime responsibilities.

## Team lifecycle API

The authenticated Team API creates ordinary Teams and reads the caller's joined
Teams. Current Team administrators can rename an ordinary Team or delete it only
when no Project ownership references remain. Personal Teams are readable by
their owner and reject rename and deletion.

| Method | Path | Result |
|---|---|---|
| `POST` | `/api/v1/teams` | `201`, Team with creator admin membership and `Location` |
| `GET` | `/api/v1/teams` | `200`, member-filtered `{items,nextCursor}` page |
| `GET` | `/api/v1/teams/{teamId}` | `200`, Team and the caller's real membership |
| `PATCH` | `/api/v1/teams/{teamId}` | `200`, Team after exact-version rename |
| `DELETE` | `/api/v1/teams/{teamId}` | `200`, `{teamId,deleted:true}` after empty deletion |

Create accepts `name` and `expectedUserId`; rename and delete also require a
positive int64 `version`. The actor guard runs before domain SQL. Delete matches
the observed name exactly. Ordinary names preserve valid Unicode and raw
whitespace, refuse NUL and all-White_Space values, and may repeat. No character
limit is added beyond the existing request-body limit. Team IDs and actor IDs
must use canonical lowercase UUIDs. GET supports HEAD; authenticated method
refusals retain `Allow`, `Daynight-User-ID` and no-store behavior.

Full Team responses add metadata version and UTC timestamps to the stable
`TeamRef`, plus the caller's real `membership` with its independent version and
timestamps. The list applies membership before `(createdAt,id)` pagination and
binds its cursor to the current user; it provides no search or total count.
No-op rename requires the current version and preserves all metadata. Stale
versions or a delete-name mismatch return `version_conflict`; Personal changes
return `personal_team_immutable`, and nonempty deletion returns `team_not_empty`.
A real rename at the maximum int64 version returns `version_exhausted`, while
an exact-version same-name no-op still succeeds. An unconfirmed COMMIT returns `503 write_outcome_unknown`; cleanup failure
retains `500 internal_error`. A lost response is not evidence of rollback and
does not authorize automatic replay.

The [authentication requirements](../../docs/spec/daynight-auth.md#team-生命周期)
own the complete public contract. The
[Team transaction design](../../docs/design/daynight-auth.md#team-元数据与生命周期事务)
owns existence locking, completion classification and independent versions.

## Team membership API

`GET /api/v1/teams/{teamId}/members` returns `{items}` only to current Team
members. Each item contains the real membership fields and
`profile:{name,email,avatarUrl}` with nullable fields. A missing canonical user
fails the entire read. Project grants do not grant directory access.

An admin changes an existing role with `PATCH /api/v1/teams/{teamId}/members/{userId}`
and `{version,role,expectedUserId}`; the response is `{membership,actorRole}`.
An admin or the member removes the relationship with DELETE at the same path
and `{version,expectedUserId}`; the response is
`{teamId,userId,removed:true,actorRole}`. The actor role is null after self-exit.
Personal membership is immutable. A stale membership version fails even for a
same-role request, and the final admin cannot be demoted or removed. Membership
changes do not alter Project grants. The actor check precedes domain SQL, and
unknown commit results must be reconciled without automatic replay.

The [authentication requirements](../../docs/spec/daynight-auth.md#team-生命周期)
own the full behavior and refusals.

## Team invitation API

Current Team admins create, list and revoke invitations at
`/api/v1/teams/{teamId}/invitations`. Create and revoke bind `expectedUserId`
before domain SQL; Personal Teams reject creation. Creation returns a one-time
`/team-invitations#<secret>` link. Metadata lists never contain the secret.
Invitations expire after seven days and grant member once.

Authenticated recipients inspect and accept through POST bodies at
`/api/v1/team-invitations/inspect` and `/api/v1/team-invitations/accept`.
Acceptance also binds `expectedUserId` and returns the actual membership and
joined/consumed flags. Existing members retain their role without consuming the
invitation. New membership and consumption commit together; revocation shares
the Team and invitation locks. Deletion removes invitations in the same
transaction. Invalid, expired, consumed, revoked or deleted targets all return
`invitation_unavailable`. The [authentication requirements](../../docs/spec/daynight-auth.md#team-邀请)
and [design](../../docs/design/daynight-auth.md#数据与并发) own the contract.

## Project transfer API

`POST /api/v1/projects/{projectId}/transfer-preview` accepts `targetTeamId` and
returns source and target Team references, target metadata version, ownership
and nullable predicted `actorRole`. `POST /api/v1/projects/{projectId}/transfer`
accepts `ownership:{teamId,version}`, `targetTeam:{id,version}` and
`expectedUserId`; only the current owner Team admin can use either operation.
The target need not include the actor. A confirmed receipt contains `projectId`,
`changed`, `sourceTeam`, `ownerTeam`, `ownership` and nullable `actorAccess`.
Same-owner requests verify both versions and leave the Project unchanged.
Actual transfers retain grants and invitations. Stale versions return
`version_conflict`; an unconfirmed commit returns `write_outcome_unknown`.
A lost receipt followed by 404 cannot establish success or authorize replay.

The transaction locks Project, ownership, then source and target Teams in UUID
order. Team deletion checks ownership in a fresh statement after its Team lock.
Transfer logs use `component=project_transfer`, resource IDs, phase, outcome,
error code and duration; names and credentials are excluded. The
[requirements](../../docs/spec/daynight-auth.md#项目归属转移) and
[design](../../docs/design/daynight-auth.md#数据与并发) own the complete contract.

## Project API

| Method | Path | Result |
|---|---|---|
| `POST` | `/api/v1/projects` | `201`, project and `Location` |
| `GET` | `/api/v1/projects` | `200`, project page |
| `GET` | `/api/v1/projects/{projectId}` | `200`, project |
| `PATCH` | `/api/v1/projects/{projectId}/settings` | `200`, full project with saved settings |

Creation accepts `name`, `repoUrl`, required `expectedUserId` and optional
`teamId`. The expected user must match the principal before domain SQL. The
caller must be a current member of the target Team; omitting it selects the
caller's Personal Team. Creation locks the Team and atomically writes Project,
ownership and creator direct admin grant; the response includes access projected
in that transaction. An unconfirmed commit returns
`write_outcome_unknown` and must not be replayed automatically. Canonical login
UPSERT, Personal initialization and session creation share
one transaction; repeat and concurrent login reuse the unique Team and validate
its owner admin. Authentication does not repair broken Personal state. Internal
Project reads require real ownership and report integrity errors for a missing
row. Public Project DTOs add required ownership:{teamId,version} across create,
GET, list, graph and sync. GET additionally returns fresh access from the same
read snapshot. GET /me adds a required personalTeam:TeamRef read from the real
validated Personal relationship. Lists contain
only projects admitted by the same current dual-source relation.
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

Project lists default to all accessible projects. `teamId` selects a Team of which
the principal is a member; `shared=true` selects direct grants outside the owner
Team. The filters are mutually exclusive. Missing or inaccessible Teams return 404;
database failures remain errors. Project cursor version 2 uses the scoped-projects
kind and binds canonical principal, all/team/shared scope, Team ID and position;
version 1 and cross-scope or cross-principal cursors are rejected. Cursors are not tamper-proof and are not authorization credentials; each request
checks access independently. No count is returned.

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

Creation uses todo, version 1, nullable execution/cancellation timestamps, allowAgents=false
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
candidates require all predecessors done or cancelled; todo and cancelled may have unfinished predecessors.

Ordinary tasks without active/released worker ownership retain the original
transitions across todo/in_progress/done and may enter irreversible cancelled. The project write
transaction acquires the project lock, rechecks membership, compares the exact
version and only then handles same-state. A current same-state request returns
the full current Task without a stored write; stale same-state conflicts. Actual
change increments once. Entering active/done requires all direct predecessors
done or cancelled, including external edges; reopening done refuses sorted direct active/done
dependent IDs. No dependent is changed. Status preserves requiredPlatform, assignedTo, PRs,
other task fields, dependency classifications and attachments. Claim-bound done atomically marks
the current worker completed; its owner and claim ID must match. Active execution
returns to todo only through release. Released tasks may become cancelled without
new execution; cancelled tasks cannot resume or withdraw to todo. Released todo tasks begin a new execution through eligible automatic acquisition or
explicit owner/admin resume, with fresh claim and worktree IDs. The
old four lifecycle routes are removed.

Execution timing describes the current attempt. Actual entry into in_progress
uses statement_timestamp() after the lock and clears the end; return to todo
clears both. In-progress to done preserves its nullable start and records an end;
todo to done records an end with null start. Cancellation records `cancelledAt`
and preserves both execution endpoints; done-to-cancelled does not erase its
completion time. Metadata and same-state preserve time.
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
opaque PR strings are not converted through PostgreSQL JSON types. Account-Worker
cursors stay at version 1; old version-1 task cursors are refused.
The assignee filter is explicit and does not change automatic worker eligibility.

## Task observation

`GET /api/v1/projects/{projectId}/tasks/{taskId}` returns the complete Task body and a required `Daynight-Task-Epoch` UUID header on success. Project permission, the Task and epoch are read in one read-only repeatable-read snapshot; a failed epoch query or transaction does not publish a success. The endpoint retains its existing authentication, 404/410 and `no-store` semantics. Unauthorized responses do not disclose the epoch.

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
counts once; the summary requires total, todo, inProgress, done, cancelled, ready and blocked,
including zero values. `total = todo + inProgress + done + cancelled` and
`todo = ready + blocked`. Only todo contributes to ready/blocked; readiness still
uses every original direct prerequisite, including prerequisites outside this
projection. Graph reads do not change stored status, revisions or timestamps.

Nodes contain `id`, `titlePreview`, `titleTruncated`, `status`, `dependsOn`,
`externalDependsOn`, `blockedBy`, `ready`, required boolean `allowAgents`, required
nullable enum `requiredPlatform`, required nullable user UUID `assignedTo`,
UTC creation/update timestamps and explicit
nullable `startedAt`/`completedAt`/`cancelledAt`. SQL produces at most 160 Unicode code points
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

`internal/core/task/codec` is the sole public DTO/codec owner;
`internal/core/task/steps` owns ordered candidates. Exact Encoder output
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
`TestStepsHTTPDelete*`. After preparing the normal auth fixture and an isolated PostgreSQL database, focused
tests can be run from this module:

```bash
source scripts/env.sh
export DAYNIGHT_TEST_DATABASE_URL='postgres://.../isolated-test-database'
export DAYNIGHT_TEST_UNIAUTH_FIXTURE="$(node scripts/prepare-uniauth-fixture.mts)"
go test ./internal/core/store/postgres/... ./internal/service/task ./internal/server/... -run 'Test(Transact|TaskSteps|Steps)' -count=1 -timeout=5m
```

For the cross-process Step text admission check, build the CLI and set
`DAYNIGHT_TEST_CLI_MAIN` to its absolute `dist/main.js` path. With the same
database and UniAuth fixture, run `go test ./internal/server -run
'^TestStepsCLITextAdmissionAcceptance$' -count=1 -timeout=5m`; use the normal
unit overlay when the production Web bundle is unavailable.

Maximum-resource HTTP tests use the `stress` build tag and run separately from
routine CI:

```bash
go test -tags=stress ./internal/server/task -run '^TestStressStepsHTTP(ExactCapacity|AddCapacity|ChangeCapacity|MoveCapacity|DeleteCapacity)Stress$' -count=1 -timeout=5m
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
credential share, real ownership share, owner-Team-member share, direct-grant
share and head update locks in that order. Only existing source rows are locked;
admission reads the stable owner Team in a new statement after the ownership lock,
merges current source facts after waits and keeps ownership and sources stable
through commit. At least one real source must still admit the writer.
A missing ownership row is an integrity error. It acquires no Project row lock
or profile projection. The final credential-expiry check follows all waits
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
materials. Cancelled tasks explicitly refuse withdrawal; retained released
history cannot restore a cancelled task. It requires no stoppedConfirmed and does not guarantee immediate
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
`startedAt`/`completedAt`/`cancelledAt`, sorted `dependsOn`/`externalDependsOn`/`blockedBy` arrays, `ready` and complete
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
UUID may share that scope, but another account's me cannot. Account-owned Worker
list cursors remain version 1.

The project-scoped task-assignees GET returns `items` and `unresolvedUserIds`
as non-null arrays. With no query it enumerates current members and assignees
retained by undeleted tasks. Repeated `userId` query arguments select a bounded
resolution mode: 1–100 distinct canonical UUIDs, with no empty, duplicate,
malformed or unknown parameters. Both arrays are sorted; in resolution mode
they are disjoint and cover the requested IDs exactly. The complete catalogue
has an empty unresolved array. HEAD and method refusal retain the authenticated
GET/no-store/Allow contract.

Each item has only userId, required version, nullable name, nullable avatarUrl
and boolean hasProjectAccess. Version is a server-issued lowercase 64-hex
SHA-256 identifier of userId/name/avatarUrl content; clients do not compute it.
Access, role, login timestamps and task references do not change an unchanged
profile version. Values preserve the canonical profile; no name or email
fallback is synthesized, and email, external identity, role, Task versions and
execution records are not returned. No scoped membership or live-task reference
means unresolved, regardless of whether a global user exists. A raw qualifying
reference whose users row is missing is an internal integrity failure, not an
unresolved ID or a null name. Both modes authorize and read references/profiles
within one repeatable-read snapshot and fail as a whole on query, scan, rows,
cancellation or transaction-completion errors.

Full catalogue reads remain available to explicit enumeration callers. The Web
uses task-sync's complete qualified-person metadata and resolves only profiles
missing from its persistent cache or carrying a changed content version, in
batches of at most 100. Picker reopening and recovery reuse unchanged profiles;
an empty set sends no request rather than omitting arguments and enumerating
everything.
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

[`TestAttachmentGrantRevocationWithFreshProcess`](cmd/daynight-server/attachment_grant_revocation_test.go)
freshly builds and launches the service and uses normal authentication, real
HTTP and isolated PostgreSQL. It holds a 1 MiB upload after admission, confirms
member removal 204 and new project access 404 before releasing the body, then
verifies upload 201, exact bytes, revoked attachment access and owned-resource
cleanup. A read of the same attachment path waits for the upload's target gate,
so the attachment denial is checked after the upload finishes. Its logged
evidence identifies the source, tree, dirty state, binary, authentication fixture,
PostgreSQL version and the test and binary race settings. The fresh child uses the test's
race mode and verifies it from the binary build information. It inherits
`GOFLAGS` and runs the child build from the module root, preserving module-relative
overlay paths. Supply an explicit source overlay through `GOFLAGS` so both the
test and its child build use it. A `go test -overlay` argument alone is not
inherited by the child build.

After setting `DAYNIGHT_TEST_DATABASE_URL` and sourcing `scripts/env.sh`, a
focused run can prepare the fixture and use the module's test-resource overlay:

```bash
export DAYNIGHT_TEST_UNIAUTH_FIXTURE="$(node scripts/prepare-uniauth-fixture.mts)"
export GOFLAGS='-overlay=scripts/unit-overlay.json'
go test -count=1 -timeout=10m -run '^TestAttachmentGrantRevocationWithFreshProcess$' -v ./cmd/daynight-server
# Explicit race evidence for both the test and its freshly built child:
go test -race -count=1 -timeout=10m -run '^TestAttachmentGrantRevocationWithFreshProcess$' -v ./cmd/daynight-server
```

A focused or dirty/overlay run is evidence only for its actual source, flags,
binary and environment; it does not replace the complete clean module check or
hosted CI. The earlier `cmd/e2e_tests` built-process and installed-CLI scenarios
were removed. Their recorded results and the
[historical acceptance decisions](../../.agents/notes/archived/testing/2026-10-22-task-lifecycle-cross-layer-acceptance.md)
remain bound to their original source; they are not current module checks. CLI
native validation and independent Web browser fixtures retain their own scopes.
