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
are grouped by project and the first two canonical task UUID characters.
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
version strings, idempotency, observed availability and failure responses. Bot
lists authorize once within their read snapshot and use one `limit+1` query
through `List` or `ListWorker`. The DAO uses ordinary Go JSON decoding; fields,
normalization and existing capacity checks belong to write ingress. Bot pages
continue by item count without domain read-byte admission or candidate callbacks.
Normal decoding and output errors propagate. Successful MCP reads have no
shared output-schema or byte admission; input checks, deadlines and resource
permits remain independent. Work overviews apply their own page budget before
the shared encoder.

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
contains enablement, maintenance and restart procedures. The [management](../../docs/design/webhook-management.md),
[capture](../../docs/design/webhook-capture.md), [delivery](../../docs/design/webhook-delivery.md),
[history](../../docs/design/webhook-history.md) and [retention](../../docs/design/webhook-retention.md)
designs own their respective data and transaction rules. Endpoint configuration,
fixed delivery destinations and 32-byte signing secrets are stored as plaintext
bytes. HMAC request signatures, current authorization, HTTPS and safe logging
remain enforced; database and backup readers can read retained credentials.

## Contracts

The [GitHub PR storage design](../../docs/design/github-pr-storage.md) describes
the independent Project resource, persisted observations and transaction scopes.
The [single-Project executor](../../docs/design/github-sync-executor.md) performs synchronization;
the [connection and scheduler design](../../docs/design/github-connection-runtime.md)
describes management, scheduling and resource lifecycle.

The [requirements](../../docs/spec/daynight-server.md) own observable behavior and
the [design](../../docs/design/daynight-server.md) owns architecture and concurrency.
Read the [organization rules](../../docs/daynight-server.md) before adding to,
modifying, or reviewing daynight-server.
The TypeScript review command retains its separate configuration, storage and
lifecycle. The client HTTP foundation targets this service's API.

The [candidate input limits](../../docs/spec/daynight-api-input-limits.md) and
[measurement design](../../docs/design/daynight-api-input-limits.md) describe
pure domain admission, protocol measurement, and the active HTTP input limits.
Bounded RawMessage output uses capped spans while retaining validation,
escaping and writer-budget semantics; the
[Raw JSON batching decision](../../.agents/notes/implemented/testing/2026-11-08-bounded-raw-json-batching.md)
owns that shared encoding mechanism. Domain online admission is owned by each
respective implementation.

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
`PATCH /api/v1/me` accepts a nonempty subset of nullable `name` and `avatarUrl`.
Omission preserves a field, null clears it, and strings retain their exact text.
Session, PAT and fixed API OAuth callers update only their own profile; Cookie writes retain the
main-site Origin check. Unknown or repeated fields, query parameters, invalid
Unicode and NUL fail. Name is bounded at 1024 UTF-8 bytes and avatarUrl at 512 KiB;
the request retains the 1 MiB/15-second read limit, followed by a separate
15-second operation deadline that inherits parent cancellation.
The strict identity transaction checks its credential, updates only submitted
columns, validates the complete profile, response and Personal Team, then checks
fresh credential time after user-row waits. Success returns the existing complete
`api.User` with no-store and `Daynight-User-ID` only after confirmed commit.
Email, verification, identity and Personal Team are preserved. Native UniAuth
login continues to replace the upstream name and avatar.

The internal `Identity.EnsureUser` operation canonicalizes an exact external key,
then inserts or reads its actual user without replacing existing profile fields.
Read-committed `INSERT ... ON CONFLICT DO NOTHING RETURNING` is followed, on
conflict, by a new exact-key SELECT. New users, Personal Teams and owner admins
share one strict transaction; failure rolls them back and unknown completion
stops the caller. The [authentication design](../../docs/design/daynight-auth.md#完整用户初始化与本人资料更新)
owns DTO admission, same-transaction credential injection and capacity checks.
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
Project members manage the tag catalog through `/api/v1/projects/{projectId}/tags`:
list, create, read, rename and confirmed deletion use stable IDs and original
versions. List cursors bind the project, principal, query, page size and catalog
epoch; `/tags/resolve` validates the complete selection within a bounded response.
Visible Task and Goal usage counts are snapshot hints, while deletion removes all
associations under the Project write lock. Task and Goal creation accepts `tagIds`
and atomically saves the validated set with the new resource; omission or an empty
array creates no associations. The receipt contains the actual references, and a
failed validation or response admission rolls back the entire creation. Task and Goal PATCH accepts the complete
`tagIds` set; omission preserves it and an empty array clears it. Mixed metadata
and tag changes commit atomically with one version increment. Full, list, ready,
search and sync results contain the current `tags` array, including `[]` when
empty. Tag rename and deletion reach associated Tasks through ordinary sync
without rotating the task cache epoch. The [HTTP specification](../../docs/spec/daynight-server.md#http-api)
and [server design](../../docs/design/daynight-server.md#领域模型与存储结构) describe the contract and implementation.
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
IDs, complete titles and Markdown descriptions using literal expressions, returns ranked
pages with their actual visible parent Goal context and tag references. Normalized
tag-set filters intersect the entire expression before ranking and pagination;
continuation rejects a changed project Task fence. [HTTP fixtures](testdata/task-search/README.md)
include successful pages and typed failures.

The [Task Session observation requirements](../../docs/spec/task-session-observation.md)
and [design](../../docs/design/task-session-observation.md) define ephemeral
Session summaries on Task list, show and graph reads negotiated with
`include=session`. The summary separates activity, the existing Web indicator,
freshness and ordinary-message eligibility; the persisted Session owner governs
eligibility. Observation failures retain Task data and mark the result partial,
while credential and Project access failures reject the entire read. Ready
queries, mutation responses, dependency-only reads and Web task-sync retain
their existing projections.

`GET /api/v1/projects/{projectId}/task-work` groups ongoing work by ordinary
dependency components. A matching in-progress child selects its component even
when its roots are done. External dependencies do not expand groups or contribute
to their summaries. Pages default to 20 groups (maximum 50), with five root
previews and twenty target previews per group. Group `cursor` and
`groupId` plus `targetsCursor` continuations are separate; Task graph changes
return `reset_required`, while Session changes do not invalidate membership.
Each page has a dedicated 256 KiB complete-response budget, including the HTTP
newline or MCP JSON-RPC envelope. MCP batch admission is per result. Continuation
uses the last returned group or target; a result that cannot fit refuses with
`resource_limit_exceeded`.

The [task-summary synchronization requirements](../../docs/spec/daynight-task-sync.md)
and [architecture](../../docs/design/daynight-task-sync.md) define the implemented
`GET /api/v1/projects/{projectId}/task-sync` endpoint. It returns a complete summary
snapshot or current records whose `updatedAt` is at least the supplied task
watermark minus `DAYNIGHT_TASK_SYNC_OVERLAP` (default `10s`). Task versions use
exact decimal strings; each intrinsic summary includes explicit nullable
assignedTo and the complete current properties object, while descriptions,
derived blockers and readiness remain outside these summaries. Task rows and
bulk property and tag-reference queries share one repeatable-read snapshot.
The required `dependencyStates` map supplies each visible ordinary Task's exact
version, retained unsatisfied prerequisites and ready state in snapshots; deltas
patch owners whose own or direct prerequisite's update falls in the window.
Its bulk query shares the snapshot and does not load Task bodies. Hidden retained
prerequisites keep their actual satisfaction state; a Goal's status does not alter
Task readiness. The current Web continues to derive readiness from its local graph.
Selected canonical property text is loaded directly into RawMessage maps; reads
do not repeat normalization, field validation or capacity admission.
Every snapshot and delta, including an empty delta,
also returns required top-level `actorAccess` using the access endpoint's DTO and
complete `assigneeVersions` entries `{userId,version,hasProjectAccess}` for the
qualified people catalogue. The existing admission result supplies access in the
same snapshot; its nested ownership and grant versions remain exact int64 JSON numbers.
People metadata contains no names or avatars, is UUID-sorted and distinct, and
uses the same qualification and content versions as task-assignees. Any profile
query, integrity or transaction failure fails the whole sync. Hashing reads all
qualified profile content on each sync, costing O(people + total profile bytes);
manifest transport is O(people).

Every successful response also includes a
required, non-null `sessions` map from Task UUID to
`working | notice | warning | pending`; an empty contribution set produces `{}`. This is
complete for the project's relevant in-progress Task Sessions even when the
Task delta is empty, and contains no execution IDs, catalogues, controls or raw
Session state. A narrow callback-scoped `SessionReader` reads Worker bindings and
persisted Session scalars in the same snapshot after existing admission and
TaskSync checks succeed. TaskSync depends on its consumer-local, single-method
`SessionStateReader`; application composition supplies the existing shared Engine.
That Engine reads only committed live scalars, without loading Current or cloning live content. Missing live or a
mismatched fence retains the existing disconnected warning; reliable initializing
or synchronizing Sessions use pending, while unreliable bindings contribute no
key. Persisted heartbeat and drain deadlines retain their existing rules.
This read does not advance Session lifecycle or replace content authorization.
Query, natural decoding, Engine admission, encoding and transaction faults fail
the whole sync. The complete response, including the map, has no domain read-byte
or graph-size admission.
The [Session projection decision](../../.agents/notes/implemented/architecture/2026-11-08-task-sync-session-projection.md)
records the narrow read and lock ownership. It introduces no PostgreSQL migration.

Browser consumers publish access only
to the current identity/project memory owner, outside persistent Project and Task
records. Missing keys propagate removal through whole-summary
replacement; ordinary property changes preserve the epoch. Write ingress owns
property normalization, fields and existing capacity rules. Reads trust the
stored canonical representation; natural decoding, encoding, database and
transaction-completion errors retain their causes. A stored project epoch invalidates caches after supported
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
increase transport, parsing and summary storage costs. The detail-cache byte
budget does not bound total summary bytes. Network, decoding and
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

`GET /api/v1/projects/{projectId}/tasks/{taskId}/sessions/{sessionId}/inspection`
reads an explicit Session's original identity, fence, `currentBinding`, readable
source and observation. It performs no lifecycle writes and never substitutes
the current Session for a historical one. Task observation permits effective
PAT, OAuth and browser Session principals through a dedicated authorization
purpose. Session user operations accept the fixed API OAuth resource, scope and
Societas client at their existing authorization points. MCP OAuth retains its
Task message, receipt and supported read subset; MCP archive reads remain limited
to Task ArchiveV1Read. Independent Test/Bot user access preserves owner and parent
PAT checks. Controller registration, grants, producer channels, archive uploads
and finalization retain their original credential requirements. Persisted
operation Actors retain their original access UUID and are reauthorized for the
actual operation before dispatch; refreshed access can query an authorized receipt
without replacing that Actor or replaying the command. Public REST authentication
admits fixed API OAuth tokens alongside PATs and browser Cookies. Task user WebSockets (v1/v2) and Test user
WebSockets (v1) accept one actual Session subprotocol with one
`daynight.authorization.<accessToken>` marker. They authenticate the fixed API
family against the exact configured application Origin, echo only the Session
protocol, and bind the connection to its effective expiry. A malformed marker
never falls back to a browser Cookie. Original polling rechecks the family and
current resource permissions; refreshed access does not extend an old socket or
replace its Actor. The [authentication design](../../docs/design/daynight-auth.md#应用用户-websocket)
owns error classification, best-effort close frames and the original connection
cleanup stages.

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
| `cmd/daynight-server/` | Environment, process signals, dependency assembly and exit status; command tests use the explicit `startupshutdown` tag |
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
`2026-07-28` and `2025-11-25`. Open the URL normally, or fetch it with `curl`, to
read its public Markdown installation manual. The manual uses the configured
`DAYNIGHT_PUBLIC_ORIGIN` and includes Codex, Claude Code and generic remote HTTP
configuration, browser authorization and connection verification. A normal HEAD
returns the same headers without a body. Reading the manual does not authenticate
or invoke business operations.

Authenticated MCP clients use `resources/list` to discover twelve product manual
Resources and `resources/read` to obtain a complete topic at its returned
`daynight://manuals/<topic>.md` URI. The short server instructions route by
operation. Steps, Thread, Session reads and messages, and attachment reads and
writes have separate guides. Every write requires the common write-safety guide
and its operation's conditions; related topics retain explicit reading prerequisites.
The materials topic defines Goal-owned shared specifications, architecture,
breakdowns, conclusions and overall progress, alongside each child Task's own
results and evidence.
Reading guidance does not select a Project or authorize work.

The manuals are embedded with the server and require no Project membership.
The explicit catalog validates complete nonempty UTF-8 bodies, strict byte sizes
and absolute topic references before registration. Rediscover the catalog and
read current content after a server update: the former `queries-and-lifecycle`,
`files-and-references` and `operation-boundaries` URIs have been replaced by the
operation guides. Unknown or removed URIs return protocol errors. Resource reads
share the Control permit through response delivery and refuse immediately when
it is exhausted. They do not change business data. The public installation manual
remains a separate entry. The [server design](../../docs/design/daynight-server.md#http-传输准入)
explains content ownership and transport boundaries.

Configure a client with the service's HTTPS URL ending in `/mcp`. Standard clients
discover OAuth from the unauthenticated protocol challenge and request the
`daynight:mcp` scope through the existing browser account. The account holder
completes sign-in and consent; adding configuration alone does not authenticate
the connection. Clients without OAuth can send an `Authorization: Bearer <PAT>`
header. Each MCP protocol request validates its own credential; browser cookies
are not accepted. GET and HEAD requests explicitly listing `text/event-stream`
or carrying MCP protocol, session, method, name or resume headers retain the
protocol path: unauthenticated requests receive the OAuth challenge, and
this stateless entry returns `405` with `Allow: POST` after authentication.
Wildcard Accept values keep the manual readable by browsers and command-line
fetches. POST always uses the authenticated protocol path.

Host checks, the Origin allowlist, shutdown admission and `Cache-Control: no-store`
apply to both documentation and protocol requests. An Origin must match
`DAYNIGHT_PUBLIC_ORIGIN` or an explicitly configured origin. The
[OAuth requirements](../../docs/spec/daynight-mcp-oauth.md) and
[architecture](../../docs/design/daynight-mcp-oauth.md) describe discovery,
the browser journey and protocol composition.
The endpoint advertises Team lifecycle, membership and scoped Project tools,
Project creation, transfer, listing and inspection,
Team invitation creation, listing and revocation, inspection and acceptance of
Team or Project invitations, Bot management, Task creation, reading, updating,
status, deletion, property, list, ready and graph tools, ordered Task Steps reads
and writes, Project tag catalog management, Task discussion reads and posts, and attachment listing, removal,
bounded reads and inline or resumable upload. The [attachment design](../../docs/design/daynight-task-attachments.md)
owns upload admission and transfer behavior. Attachment open creates a private immutable snapshot for ranged
reads; each request rechecks access. Inspection returns metadata by default,
explicit reads default to 8 KiB, and binary content requires base64 selection.
Inspect and open return complete metadata through ordinary reads without
stored-field or result-byte admission. Requested paths and content ranges retain
their input and I/O security rules. Close and expiry reclaim only the private snapshot.
Invitation links are returned
only by creation; listing returns metadata without secrets. Task mutation inputs
use the existing 1 MiB business JSON limit; versions are decimal strings and
property values use `valueText`. Task and Step reads default to marked
summaries; request `full` for complete content. Task full and summary schemas
require `type` and nullable `parentId`; the Goal full schema also describes
`progress`. MCP creation accepts ordinary Tasks and Goals; Task list and ready
filters select Goal membership, and Task updates can assign or clear a Parent.
Task and Goal creation and updates accept `tagIds` as a complete set of Project
tag UUIDs. Omission on creation selects none; omission on update preserves the
set and `[]` clears it. Task full and summary results include `tags` references
with stable IDs and current names, including an empty array when untagged. A
tag-only update uses the dedicated association operation; mixed changes commit
with metadata in one transaction. Unknown outcomes require a read before deciding
what to do next.
Step page cursors bind the parent version and reject
continuation after a change. Step writes return confirmed version and change facts
and preserve the original collection capacity. Discussion reads return complete
messages in oldest-first order; an explicit claim ID supplies agent attribution.
A lost post response does not establish a receipt: read the thread before
deciding whether to send again. Bot creation resolves omitted settings from
available Worker defaults and does not imply startup readiness. Bot deletion
requires an explicit version and reports the separate Worker and server cleanup
states. Team and membership versions are decimal strings, and list results use
scoped cursors. Team, member, scoped Project, invitation and attachment pages
use ordinary candidate batches and item-count continuation. Reads preserve full
items without field-budget admission or repeated prefix encoding.

`tag_list`, `tag_show`, `tag_create`, `tag_rename` and `tag_delete` use the
shared Project tag service and Control permits. Catalog pages default to 50
items (maximum 100), return `catalogEpoch` and bind the cursor to the Project,
principal, query, limit and epoch. Tag versions are exact positive decimal
strings; rename and deletion require the observed `ifVersion`, and deletion
also requires `confirm: true`. Usage counts are snapshot hints, not a deletion
condition. Mutation results retain confirmed, not committed or unknown completion;
an unknown creation or deletion must not be replayed blindly.

`project_resolve` reads the unique accessible Project for a supplied repository
address, returning its ID in `data.id`. Equivalent HTTPS, SSH and SCP addresses
use the registration identity rules. No match returns `not_found`; multiple
visible matches return `resource_conflict`. Invalid addresses and addresses over
4096 UTF-8 bytes return `invalid_input`. The scan uses one read-only snapshot,
does not create or bind a Project, and does not access local or remote Git.
Later operations check access again.

Task list excludes done tasks by default and orders in-progress, ready, blocked
and done tasks before paging. Its cursor binds the caller, project, filters and
view to a snapshot fence; `list_changed` requires restarting traversal when
project task versions change. Task list pages use item-count continuation, and
Task graph summary and full views return the complete selected graph. They do
not apply domain read-byte or graph-size admission. Successful MCP reads use
ordinary encoding without runtime output-schema validation or shared result-byte
admission; advertised schemas are verified by protocol tests. Input, concurrency
and deadline rules remain. `task_list`, `task_show` and normal `task_graph` reads
include Session observations with `meta.observedAt`, `partial` and resource
references. `task_work_list` calls the work-overview use case, including its
dedicated response budget. Session module registration advertises only
implemented capabilities.

`task_ready` returns the first matching ready Tasks ordered by creation time and
UUID. Its `limit` defaults to 5 and accepts 1 through 20; permission and platform
filters apply before the limit. Each call reads the current first batch without
pagination. The result contains `items` and `projection`, with no `nextCursor` or
`next` continuation. It does not calculate a response byte budget or shorten the
batch based on encoded size. The default `summary` contains marked title previews
and selection fields; `view: full` returns complete Tasks, including descriptions
and properties. MCP input, deadline and resource-permit rules still apply;
successful read results have no schema or byte admission.
To traverse all ready tasks, use `task_list` with `ready: true`; its full list
projection omits descriptions. Read current complete Tasks separately through
`task_show` with `view: full`. These separate reads do not share the list's fence.

`task_search` applies a nonempty literal expression and optional tag and Task
filters through the same ranked search as REST. Its lean page contains identity,
membership, title, status, match evidence and tag references, without complete
descriptions. The default limit is 50 (maximum 100). Repeat the expression and
filters with `nextCursor`; a changed snapshot returns `search_changed`. Invalid
tag selections return `invalid_tag_filter`. Use `task_list` for tag-only queries.

OAuth grant families store only 32-byte SHA-256 hashes of canonical secrets with
32 random bytes. MCP retains its actual client, `/mcp` resource, `daynight:mcp`
scope and `dnmcp_` / `dnmcr_` prefixes. Its grant and refresh have an absolute
30-day limit; access lasts at most one hour and never exceeds that grant deadline.
The API profile fixes `societas-bot` / `Societas Bot`, `/api/v1`,
`daynight:api` and `dnapi_` / `dnapr_`. Its issuer returns secrets only after a
confirmed family commit. `POST /api/v1/oauth/s2s/token` accepts one
`Authorization: S2S <shared-key>` and strict `{externalUserId,profile?}` JSON. The
adapter rejects invalid or disabled credentials before user initialization. The
service commits a complete user/Personal Team before independently issuing the
family; a later failure can retain the complete account. Only a confirmed family
commit returns the exact API token DTO, including actual user/grant IDs and
access/grant deadlines. Body reads are limited to 1 MiB and 15 seconds, with a
separate 15-second operation deadline after decoding.

REST `Bearer dnapi_...` authentication validates the actual fixed API tuple,
family, user, revocation and expiry before ordinary user business operations.
Explicit Authorization retains precedence; malformed, duplicate or invalid
credentials never fall back to Cookies. Existing account-root, browser consent,
PAT management and producer restrictions remain. Public `/oauth/token` accepts
API refresh with the fixed client/resource and optional exact scope using public
client authentication, without another S2S key. API authorization-code exchange
is unavailable. Refresh form reads retain 64 KiB/15-second limits; API refresh
gets a separate 15-second operation deadline. API refresh returns the same token
DTO as issuance, while MCP retains its original five fields. Public
`/oauth/revoke` recognizes matching API access/refresh families; native owner
lists and revoke expose the real application and rolling deadline. Explicit
reconnection issues a new grant; ordinary failures never reissue automatically.
Revoking a family does not delete user resources or cancel dispatched work.

Successful REST and user WebSocket API authentication record `http_oauth` once
against the actual grant; confirmed refresh records `oauth_refresh`. Issuance,
internal rechecks, polls and unknown outcomes do not manufacture usage. Metadata
faults preserve the original authentication/business result. Unknown commit
returns no secrets, and lost committed responses cannot recover plaintext or
prove rollback. The [application authorization contract](../../docs/spec/daynight-auth.md#用户应用授权-api)
owns exact inputs, token fields and failure semantics.

API rotation locks the grant and refresh before reading a fresh database time.
A valid rotation atomically consumes the old refresh, sets the grant and new
refresh deadline to that time plus 30 days, and inserts a one-hour access token.
The grant creation time and older token deadlines remain unchanged. Correctly
bound replay within the old refresh's original lifetime revokes the family;
replay after that deadline only fails. Ordinary access, failures and usage
metadata do not renew a grant. Unknown completion or a lost response does not
recover or replay secrets.

The principal carries the actual user and access credential IDs, while the stable
authority reference carries the grant ID. Binding-aware family authentication
returns the earlier access/grant deadline. Family checks retain grant-share then
access-share locking; the existing CredentialReader keeps its snapshot behavior,
access-only shared locks and checks after lock waits while joining the actual
family and user. Revocation invalidates access rows in the same transaction.
The [authentication design](../../docs/design/daynight-auth.md#oauth-family-的固定-profile-与-api-授权)
owns fixed profiles, rolling deadlines and reader contracts.

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
Go heap. After preparing an isolated database, run it
separately from CI:

```bash
go test -race -tags=stress ./internal/server/mcp -run '^TestStressMCPStepsCapacityAndConcurrentSummaryHeap$' -count=1 -timeout=10m
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
The gateway publishes host `127.0.0.1:8787` for the application and
`127.0.0.1:8788` for metrics, forwarding each over a separate TCP stream to the
server's loopback listeners in their shared network namespace; the database has no
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
export DAYNIGHT_ROOT="$PWD/.tmp/server-root"
export DAYNIGHT_PUBLIC_ORIGIN='http://127.0.0.1:8787'
export DAYNIGHT_UNIAUTH_URL='https://identity.example.com'
export DAYNIGHT_UNIAUTH_APP_ID='<registered-app-id>'
export DAYNIGHT_UNIAUTH_APP_SECRET='<server-side-app-secret>'
export DAYNIGHT_UNIAUTH_CALLBACK_URL='http://127.0.0.1:8787/api/v1/auth/callback'
export DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN=1
.tmp/daynight-server --root "$DAYNIGHT_ROOT"
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

The server selects an absolute root from `--root`, `DAYNIGHT_ROOT`, or
`/var/lib/daynight`, in that order. It reads optional `config/config.yml` and
`config/config.local.yml` under that root, then applies explicitly set environment
variables. Copy [config.example.yml](config/config.example.yml) to the root's
config directory and keep credentials private. Defaults apply once before the
files; a field in a later layer replaces the earlier value, including false,
zero, empty strings and collections. Explicitly empty numeric, flag and duration
environment values are invalid. Unknown YAML fields are ignored; duplicate keys,
invalid types, null known fields, malformed or multiple documents fail startup.
Relative file paths resolve against the root; storage defaults to `storage`.
Loading configuration does not create directories or open business resources.
Modules own their fields, defaults and validation; `internal/config` coordinates
loading and cross-module checks.

The executable accepts `--root` for normal startup or after `verify-storage`.
Unknown, repeated and extra arguments fail before business resources open, without
echoing argument values. `verify-storage` validates only database and storage
semantics and opens the backup storage read-only. Logs remain on stderr.

Normal startup acquires an exclusive lock in `logs/.writer.lock` under the
selected root, then appends the same JSON records to stderr and
`logs/daynight-server.log`. The private directory and newly created files use
0700 and 0600 permissions. The active file rotates at 100 MiB, retaining ten
numbered files; an oversized record remains intact. Each server instance needs
its own root and log directory, even when it shares an absolute storage root.
The lock file persists across restarts. A logging failure stops the server with a
nonzero exit and a safe `logging_failed` diagnostic on stderr when available.
Writes are synchronous but do not promise per-record fsync.

Use credentials suitable for the local PostgreSQL instance. The process validates
the connection before listening and exits nonzero on startup or shutdown failure.
It never logs the database URL, driver error text, SQL, request body, or query
string. Errors retain their original causes internally; logs expose safe
diagnostics and cause categories.

| Environment variable | Meaning | Default |
|---|---|---|
| `DAYNIGHT_DATABASE_URL` | Explicit PostgreSQL connection string | Required |
| `DAYNIGHT_REDIS_URL` | Monitoring-only `redis` or `rediss` URL; an empty value disables monitoring | Empty |
| `DAYNIGHT_WEBHOOK_ENABLED` | Permit webhook configuration expansion and network claims (`0` or `1`) | `0` |
| `DAYNIGHT_GITHUB_ENABLED` | Enable GitHub App configuration (`0` or `1`) | `0` |
| `DAYNIGHT_GITHUB_APP_ID` | Positive GitHub App ID, required when enabled | Unconfigured |
| `DAYNIGHT_GITHUB_PRIVATE_KEY_FILE` | RSA PEM private key path, required when enabled | Unconfigured |
| `DAYNIGHT_GITHUB_WEBHOOK_SECRET` | Webhook secret, required when enabled | Unconfigured |
| `DAYNIGHT_STORAGE_ROOT` | Writable local storage directory; relative to the selected root | `storage` |
| `DAYNIGHT_PUBLIC_ORIGIN` | Exact main-site origin, HTTPS in production | Required |
| `DAYNIGHT_MCP_ALLOWED_ORIGINS` | Comma-separated exact browser origins additionally permitted for MCP requests | Only `DAYNIGHT_PUBLIC_ORIGIN` |
| `DAYNIGHT_S2S_SHARED_KEY` | Server-only S2S issuer key; empty disables issuance, otherwise 32–256 visible ASCII bytes | Empty (disabled) |
| `DAYNIGHT_S2S_ALLOWED_ORIGIN` | One canonical exact application browser origin for user REST CORS | Empty (disabled) |
| `DAYNIGHT_OAUTH_PREREGISTERED_CLIENTS` | JSON object mapping client IDs to public client metadata documents with matching `client_id` | Empty |
| `DAYNIGHT_MCP_TEMP_BUDGET_BYTES` | Positive decimal byte budget shared by private MCP transfer content across instances | `8589934592` (8 GiB) |
| `DAYNIGHT_MCP_RESERVED_FREE_BYTES` | Nonnegative decimal bytes kept available for ordinary storage when reserving transfer capacity | `1073741824` (1 GiB) |
| `DAYNIGHT_UNIAUTH_URL` | UniAuth gateway origin | Required |
| `DAYNIGHT_UNIAUTH_APP_ID` | Registered UniAuth backend App ID | Required |
| `DAYNIGHT_UNIAUTH_APP_SECRET` | Server-only UniAuth App secret | Required |
| `DAYNIGHT_UNIAUTH_CALLBACK_URL` | Exact same-origin callback URL with a canonical non-root path and no query/fragment | Required |
| `DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN` | Explicit main-site HTTP test-origin and loopback application CORS test policy (`0` or `1`) | `0` |
| `DAYNIGHT_ALLOW_LOOPBACK_HTTP` | Separate SDK permission for a literal loopback UniAuth HTTP gateway (`0` or `1`) | `0` |
| `DAYNIGHT_LISTEN_ADDR` | Numeric loopback IP and port, including IPv6 syntax | `127.0.0.1:8787` |
| `DAYNIGHT_METRICS_LISTEN_ADDR` | Optional numeric IP and port for the independent metrics listener | Empty (disabled) |
| `DAYNIGHT_STARTUP_TIMEOUT` | Positive Go duration for database connection and listener startup | `10s` |
| `DAYNIGHT_SHUTDOWN_TIMEOUT` | Shared positive shutdown duration, at most 10 seconds | `10s` |
| `DAYNIGHT_TASK_SYNC_OVERLAP` | Positive Go duration subtracted from a supplied task-summary watermark | `10s` |
| `DAYNIGHT_IMAGE_NODE_PATH` | Path to the pinned Node.js 24 executable | Unconfigured |
| `DAYNIGHT_IMAGE_HELPER_PATH` | Path to the packaged image validation helper | Unconfigured |
| `DAYNIGHT_IMAGE_MANIFEST_PATH` | Path to the helper and engine SHA-256 manifest | Unconfigured |
| `DAYNIGHT_IMAGE_TEMP_DIRECTORY` | Path to the private staging directory (mode 0700) | Unconfigured |

GitHub App settings are validated locally on startup when enabled; invalid keys or
missing credentials stop startup without exposing their contents. Relative key paths
resolve from the configuration root. The [remote design](../../docs/design/github-app-remote.md)
describes token handling and the read contract. When enabled, the server starts
the bounded synchronization worker and exposes Project administrator connection
and settings operations. Configure the GitHub App with Pull requests read access
and install it on the target repository. Set the App's HTTPS webhook URL to
`/api/v1/github/webhook`, configure the same webhook secret, and subscribe to
pull request and installation lifecycle events. The reverse proxy must allow a
26,214,400-byte request body. The receiver persists refresh hints before
acknowledging relevant deliveries; polling repairs missed deliveries. See the
[connection and scheduler design](../../docs/design/github-connection-runtime.md).

Each Project's PR synchronization defaults to off, independently of its GitHub
connection. An administrator enables it after connecting; disabling it retains
the connection and saved PRs. When upgrading across migration 073, stop and drain
every old server replica before migrating, replace all replicas, and then start
the new servers. Old binaries ignore the synchronization setting and must not run
alongside the new version. Existing Projects also migrate with synchronization
off and require an administrator to enable it again. The migration retains the
binding, PRs and history while invalidating old work and pending hints.

`s2s.shared_key` / `DAYNIGHT_S2S_SHARED_KEY` is optional and server-only. Empty
disables S2S issuance; a nonempty value must contain 32 through 256 visible ASCII
bytes (0x21–0x7e), without whitespace or a required prefix. Invalid values stop
startup without exposing the key. It is loaded on startup and compared in
constant time. Restart after replacement; existing families and refresh remain
independent of the key. Both Compose templates preserve absent, explicitly empty
and nonempty values, as described below for the optional origin.

`s2s.allowed_origin` / `DAYNIGHT_S2S_ALLOWED_ORIGIN` accepts one canonical exact
HTTPS origin: lowercase host, no default port, userinfo, path, query, fragment or
wildcard. HTTP requires `DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN=1` and a literal localhost
or numeric loopback application host. Invalid values fail startup. If the environment
variable is absent, the loaded YAML value remains effective. The supplied
localhost and dev-ci Compose configurations preserve that distinction: an absent
variable in both the host environment and private environment file retains YAML;
an explicitly empty value overrides YAML and disables application browser CORS;
a nonempty value overrides YAML with that origin. The blank entry in
[localhost .env.example](../../deployment/localhost/.env.example) deliberately
disables browser CORS when copied unchanged without a host override. The host
environment takes precedence over the private environment file. An empty origin
leaves no-Origin REST, trusted issuance and public refresh available.
Restart after changing it. The outer user REST adapter decorates success and error
responses and handles registered-method preflight without credentials or business
work. It echoes the exact origin, merges Vary and sends no
Access-Control-Allow-Credentials. Native Cookie mutation, account-root and
producer authentication remain unchanged. Public OAuth/MCP retain their separate
CORS; the S2S issuer, static assets and health routes are outside this adapter.
The [authentication design](../../docs/design/daynight-auth.md#用户-rest-的精确-cors)
owns the complete allowed and exposed header tables and method rules.

Image validation settings are configured together or omitted together. Omitting
them retains text service and refuses new image uploads. A configured runtime,
helper, engine or manifest that fails validation prevents startup; it does not
silently enable a weaker decoder. The deployment image supplies all four paths.
The service and Controller independently consume every decoded image frame and
check original length and SHA-256. Each service decoder has a fixed 15-second
deadline; cancellation waits for the helper process to exit before releasing its
private staging files. Decoder RSS is measured, not a hard OS memory sandbox.
See the [media design](../../docs/design/session-image-contracts.md). Decoder
deadline tests check the constructed production duration and use a shorter
private instance interval while retaining the real process and timer, as recorded
in the [instance timing decision](../../.agents/notes/implemented/testing/2026-11-07-integration-test-timing.md).

The business listener rejects wildcard, non-loopback, hostname, scoped IPv6, and
malformed addresses. The optional metrics address accepts literal IPv4 or IPv6,
including wildcard addresses, without a scope; hostnames are rejected. Its port
must be canonical decimal in `0..65535`, and the two configured nonzero ports
must differ. Port zero requests an ephemeral port; the lifecycle log reports the
actual bound address. Callback paths that collide with application routes are rejected during
configuration and startup validation before route registration; this includes
`/mcp`, `/login`, `/auth/complete`, `/setup`, `/teams` and every descendant path, together with the
`/api/v1/teams` API namespace and `/api/v1/webhook-event-types`. If an existing callback occupies that
namespace, choose another path and register its exact full URL in UniAuth before
starting the server. Login return loops, including `/login` and `/auth/complete`, are rejected before a
login transaction is created. An absent return target defaults to `/projects`; a
known callback failure redirects to the explicit login error page and retains the
validated target, including when local session creation fails. A successful callback
sets the session Cookie and redirects to `/auth/complete` with the complete encoded
return target, including its query and fragment, and the escaped path of the
callback request.
The completion page validates that local path and uses it to preserve the original
redirect destination for accepted relative references. The existing Web shell serves
that page over GET/HEAD; other methods are rejected. Only the configured callback
path is routed; there is no fixed-path alias or authentication-disable mode. The two HTTP exceptions control different origins and do not imply each
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

## Metrics

Metrics are disabled when `DAYNIGHT_METRICS_LISTEN_ADDR` is empty. Set it
explicitly to start a separate listener, for example:

```bash
export DAYNIGHT_METRICS_LISTEN_ADDR=127.0.0.1:8788
# IPv6 loopback alternative: export DAYNIGHT_METRICS_LISTEN_ADDR='[::1]:8788'
curl --fail-with-body http://127.0.0.1:8788/metrics
```

`GET` and `HEAD` serve the exact `/metrics` path; other methods return 405 with
`Allow: GET, HEAD`, and other paths return 404. The business listener does not
serve metrics. This endpoint has no application authentication: choose the
bind address and network rules to restrict scrapers. In containers, a loopback
listener is reachable only within its network namespace; use a separate secured
forwarder or an appropriately restricted container network when needed. The
[localhost stack](../../deployment/localhost/README.md) provides a separate
host-loopback TCP forwarding port.

Each enabled App owns an independent Prometheus registry with its PostgreSQL
pool collector and the official default Go and process collectors. Their `go_*` and `process_*` families describe
the Go runtime and this process, not the machine. Availability depends on the
platform and build; Linux process collection requires readable `/proc`.
The pool collector reads one local `pgxpool.Stat` snapshot per scrape without
issuing SQL. It exposes the following families for the App's own pool:

| Metric | Type | Meaning |
| --- | --- | --- |
| `daynight_postgres_pool_connections` | Gauge | Connections with `state` of `acquired`, `idle`, or `constructing` |
| `daynight_postgres_pool_total_connections` | Gauge | Current total connections |
| `daynight_postgres_pool_max_connections` | Gauge | Configured connection limit |
| `daynight_postgres_pool_acquires_total` | Counter | Successful acquisitions |
| `daynight_postgres_pool_acquire_duration_seconds_total` | Counter | Total time spent in successful acquisitions, in seconds |
| `daynight_postgres_pool_canceled_acquires_total` | Counter | Acquisitions canceled by context |
| `daynight_postgres_pool_empty_acquires_total` | Counter | Successful acquisitions that waited for an empty pool |
| `daynight_postgres_pool_empty_acquire_wait_seconds_total` | Counter | Total empty-pool wait time for those successful acquisitions, in seconds |

Among the pool families, only the connections family has labels. These acquisition durations are not SQL
execution latency; the pool metrics do not describe the database server's CPU or
resource use. Counters reset when the process restarts.

Collection failures are exposed rather than replaced with zero values. Scrapes
negotiate Prometheus text or OpenMetrics; clients should parse according to the
response Content-Type. At most two scrapes execute concurrently; further
requests receive 503. The endpoint's read-header and read timeouts are 5 seconds,
write timeout is 10 seconds, and idle timeout is 60 seconds. A timeout does not
force a collector to stop; shutdown waits for active scrapes before closing App
resources. See the [metrics design](../../docs/design/server-metrics.md) for
registry and lifecycle ownership.

Business requests expose `daynight_http_requests_total` (Counter),
`daynight_http_request_duration_seconds` (Histogram, seconds) and
`daynight_http_requests_in_flight` (Gauge). The counter labels are `method`,
`route`, `mode`, `status` and `outcome`; the histogram uses only `method`,
`route` and `mode`. Its classic buckets are 0.005, 0.01, 0.025, 0.05, 0.1,
0.25, 0.5, 1, 2.5, 5, 10, 30, 60 and 300 seconds, plus `+Inf`.

The route is the registered template without its method prefix, or `unrouted`
when no pattern matched. Methods outside GET, HEAD, POST, PUT, PATCH, DELETE,
OPTIONS, CONNECT and TRACE are `OTHER`. Modes are `http`, `websocket` and
`sse`; streaming durations cover the handler or connection lifetime, so select
`mode="http"` for ordinary request latency. The first final response status is
retained; an uncommitted abnormal exit uses `none`. Outcomes, in descending
priority, are `panic`, `aborted`, `write_error`, `canceled` and `returned`.
A canceled stream is not automatically a server failure. These observations do
not prove complete client receipt. Business health requests are included; scrapes
on the separate listener are excluded.

## Validate

Complete server validation runs both the module and startup/shutdown checks.
Install root workspace dependencies with `pnpm install --frozen-lockfile` first.
Both checks require `DAYNIGHT_TEST_DATABASE_URL` to identify an isolated
PostgreSQL instance. The module check also requires `DAYNIGHT_TEST_REDIS_URL`
for an isolated Redis instance; it owns SQL, Redis and other module mechanisms,
while the startup/shutdown check owns command lifecycle mechanisms.
Database-independent suites have focused commands below.
The regular Session HTTP selection uses Go dependencies and local transport
fixtures without database, gateway, CLI or Web preparation. For disposable
instances for the complete check, use PostgreSQL **18.6-bookworm** and Redis
**8.10.3**, as in CI:

```bash
docker run --detach --name daynight-server-tests \
  --env POSTGRES_USER=daynight --env POSTGRES_PASSWORD=daynight-test \
  --env POSTGRES_DB=daynight --publish 127.0.0.1::5432 postgres:18.6-bookworm
docker port daynight-server-tests 5432
docker exec daynight-server-tests pg_isready -U daynight -d daynight
docker run --detach --name daynight-server-redis-tests \
  --publish 127.0.0.1::6379 redis:8.10.3 \
  redis-server --save "" --appendonly no --maxmemory 64mb --maxmemory-policy noeviction
docker port daynight-server-redis-tests 6379
docker exec daynight-server-redis-tests redis-cli ping
```

Set the reported loopback ports in the test URLs, then run:

```bash
export DAYNIGHT_TEST_DATABASE_URL='postgres://daynight:daynight-test@127.0.0.1:PORT/daynight?sslmode=disable'
export DAYNIGHT_TEST_REDIS_URL='redis://127.0.0.1:PORT/0'
bash scripts/check.sh
bash scripts/startup-shutdown.sh
docker rm --force --volumes daynight-server-tests
docker rm --force --volumes daynight-server-redis-tests
```

The module check builds and vets the Go module using its unit-test Web resource
overlay, prepares the pinned UniAuth fixture, and runs module tests and coverage.
Its optional `--coverage` argument selects the same check. The independent
startup/shutdown check runs the command tests with `-tags=startupshutdown` and
the controlled Webhook Runner abrupt-recovery witness with its dedicated test
transport build. Production builds use the real Web assets described under
[Build and run](#build-and-run).

### Startup and shutdown tests

`bash scripts/startup-shutdown.sh` owns command configuration and exit status,
startup and readiness, graceful shutdown and deadlines, concurrent migrations,
migration failure recovery, persistence across restart, attachment
revocation during an admitted upload, and private-transfer orphan recovery after
abrupt process exit. The command tests stay in
`cmd/daynight-server` so they exercise the private `main` and `run` entries, but
the explicit `startupshutdown` build tag keeps them out of ordinary module test
discovery. The entry also runs `TestWebhookRunnerAbruptProcessRecovery` with
`webhooktest`, preserving its controlled process-exit and lost-acknowledgement
proofs. Stress workloads retain their separate local command.

Normal Project/Task API creation, state progression and readback belong to
[Go API integration](#go-api-integration). Protocol refusals stay in mocked HTTP
tests; listener-origin binding and cancellation stay in the command lifecycle
tests. Real authentication, SQL, locks and subprocesses remain where they are
necessary to prove the owned mechanism.

The lifecycle runner uses Node.js for command deadlines on Linux and macOS;
GNU `timeout` is not required. Expiry and interruption fail validation after
TERM and bounded KILL escalation, including descendants left by an exited
command leader. Ordinary exit codes and streamed output are preserved.

The independent `verify-server-startup-shutdown` CI job follows the server's
directory selection, uses its own PostgreSQL service and does not wait for
module validation. The final gate requires actual success for both selected Go
jobs. Their separate [coverage partitions](#coverage) retain all production code
and the same numerical thresholds.

### Project HTTP tests

`internal/server/project` tests use the real request-authentication parser and
Project registrar. Protocol cases use strict direct operation callbacks where
precise outcomes are needed; organization scenarios also execute real Project
Service and Core over controlled DAO facts. They retain HTTP routing, parsing,
argument propagation, DTOs, error/log classification, cancellation and
response-write failure mechanisms. Their ordinary test binary clears database
and UniAuth fixture configuration; run the complete adapter suite independently:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -timeout=5m -overlay=scripts/unit-overlay.json ./internal/server/project
```

Core and Service tests own their complete business decision matrices. PostgreSQL COMMIT response
loss, transaction effects and independent persisted readback belong to Store
owners; retained files and reopen behavior belong to local storage tests. The
explicit `acceptance`-tagged process-restart witness retains its real isolated
infrastructure and is excluded from the ordinary test binary's environment reset.

### Application service tests

The root `internal/service` suite owns application composition, startup,
readiness, background supervision, resource retention and close retry. It runs
the production assembly body through instance-owned resource openers, using a
controlled persistence backend and real Session Engine, local files and permits.
The public `OpenAppWithLogger` entry selects native openers; tests select only
their lower resources rather than constructing a replacement application.

The shared `openPersistence` binding is exercised by both application assembly
and `OpenPersistence`. Its transaction capabilities, readiness callback and close
callback refer to the same backend instance. Strict startup and background facts
reject unconfigured calls, and concurrent work is cancelled and drained before
its dependencies are released. Supplied metadata and completion facts do not
simulate a database or establish persistence.

The test binary clears `DAYNIGHT_TEST_DATABASE_URL` and
`DAYNIGHT_TEST_UNIAUTH_FIXTURE`. Run the ordinary suite and the explicitly tagged
partial-start witness without either fixture:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -timeout=5m -overlay=scripts/unit-overlay.json ./internal/service
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -timeout=5m -overlay=scripts/unit-overlay.json \
  -tags=webhooktest -run '^TestWebhookPartialStartRetainsDependenciesUntilRunnerStops$' ./internal/service
```

Native configuration, UniAuth client, unusable storage, malformed database URL
and failed database-open paths still execute their real public entry. Identity
HTTP tests retain their actual local transport and body lifetime. Domain rule
and completion matrices belong to their core or child service owner; SQL,
snapshots, locks, rollback and Worker configuration CAS belong to Store tests.
Successful native application/process composition remains in the independent
[startup/shutdown check](#startup-and-shutdown-tests). The
[root service ownership decision](../../.agents/notes/implemented/testing/2026-11-09-root-service-test-ownership.md)
records the proof allocation and the shared-factory rationale. Runtime comparisons
include receiving packages; removed database preparation is distinct from moved
physical work.

The inner `internal/service/application` suite verifies the business-module
construction shared by protocol adapters. It records Projects, Tasks and
Attachments constructor arguments and returned module identities through the
same production assembly body. Identity construction receives the original writer,
client and callback, and its concrete result occupies the 18-method output used
by Authentication and MCP. The wrappers call real pure constructors; fixed
business data does not require Project/Task/Attachment or Identity workflows or
PostgreSQL.
Actual Session/Engine identity, origin propagation and operation/stop/close
behavior remain real, with store and files borrowed from their external owners.

Run the inner suite without database or UniAuth fixtures:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -timeout=5m -overlay=scripts/unit-overlay.json \
  ./internal/service/application
```

The existing API attachment normal flow retains complete byte and final Project
readback through production construction. Exact constructor dependency identity
and that normal connectivity prove different responsibilities. The
[inner assembly test decision](../../.agents/notes/implemented/testing/2026-11-09-business-application-assembly-tests.md)
records the three bindings and the retained lifetime proof.

### Webhook retention configuration tests

Retention binds one stateful Core configuration collector through its private
Reconcile/Pass contract. The selected service tests control those operations and
verify context, Store identity, exact quota, result aggregation, observations,
internal timeouts and single-flight drain. Native ReceiptCollector work and
history scope callbacks remain real. Configuration unknown-state and lifecycle
cases keep the default collector and its state across passes.

Core uses its existing strict collection plan for the original eligibility rules,
pending barrier and all 125 configuration candidates. Complete context, identity
and order checks supplement the original affected-row observation. Run the
selected owners without database or UniAuth fixtures:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -overlay=scripts/unit-overlay.json \
  -run '^(TestConfigCollector|TestRetention)' \
  ./internal/core/webhook ./internal/service/webhook
```

The [configuration operation test decision](../../.agents/notes/implemented/testing/2026-11-09-retention-config-operation-test-owners.md)
records this allocation and the retained native-state proofs. Store continues to
own actual SQL, locks, barriers, completion and persisted readback; stress cases
retain their separate tagged entry.

### Worker admission tests

The `internal/service/worker` admission subset controls directly invoked Core
report operations, transaction scopes and DAO results. It executes real report
orchestration and encoding, with exact argument/order checks, independent
completion outcomes, cancellation and result suppression. Production
constructors retain the real Core bindings. Run this subset without database or
UniAuth fixtures:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -overlay=scripts/unit-overlay.json \
  -run '^TestWorkerAdmission' ./internal/service/worker
```

Core admission tests own 99/100/101 decisions and active-window boundaries.
PostgreSQL Worker tests retain real owner locks, counts, clock samples and expiry;
root Store tests retain `WriteWorker` completion, physical rollback, cancellation
and persisted readback. Other Worker suites use the fixtures required by their
own proof. The [admission test decision](../../.agents/notes/implemented/testing/2026-11-09-worker-admission-test-owners.md)
records these proof owners.

### Worker HTTP tests

`internal/server/worker` owns the Worker route input, telemetry, privacy and
configuration protocol matrices. The ordinary report and configuration cases
assemble the real Worker registrar, request authentication, Service and Core
with controlled storage capabilities; exact refusal and capacity cases use
strict operation callbacks. Controlled results do not prove physical commits.
`internal/server/httpx` owns the error classification and response mapping for
Worker transaction failures and Session content faults. Root retains its shared
fixtures for other consumers. Existing integration tests retain their real
infrastructure requirements.

### Worker capacity tests

The `internal/server/worker` Report and Configuration capacity matrices register
real Worker HTTP routes and credential middleware with direct Worker operation
mocks. They check full arguments, exact calls, response content and private headers. Report
byte-field overflows arrive at the operation and receive a supplied service
refusal; Report collection overflow is rejected by the actual wire parser.
Configuration PUT and observation overflow inputs are parsed before any business
call. Observation success additionally returns configuration protocol version 1
and its complete accepted receipt. Both assistant-host HTTP tests use the same
strict operation fixture; their lower rules have separate receiving owners.

`internal/core/worker` owns the original thirteen Report byte/count boundaries,
normalization and full snapshot projection. Its Configuration capacity tests
retain the eight input boundary pairs and actual Put/Exchange behavior, including
exact next revision and full writes, unchanged 128-project configuration without
reauthorization, and complete maximum observation arguments. Expected inputs,
current facts and supplied results are independent. Run these selections without
database or UniAuth fixtures:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -overlay=scripts/unit-overlay.json \
  -run '^(TestWorker(Report|Configuration)Capacity|TestPutConfigurationCapacity|TestExchangeConfigurationCapacity)' \
  ./internal/server/worker ./internal/core/worker
```

Real HTTP request-size boundaries for configuration protocols 1 and 2, the
ordinary report limit, and a native application with 128 maximally sized escaped
arguments are exercised separately from routine CI:

```bash
go test -tags=stress ./internal/server/worker \
  -run '^TestStressWorkerReport(BodyLimits|LargeNativeApplication)$' -count=1 -timeout=5m
```

The [Report capacity decision](../../.agents/notes/implemented/testing/2026-11-09-worker-report-capacity-test-owners.md)
and [Configuration capacity decision](../../.agents/notes/implemented/testing/2026-11-09-worker-configuration-capacity-test-owners.md)
record their protocol, rule and projection proof owners. Other root HTTP tests
retain their own environment requirements.

### Worker assistant-host HTTP tests

The first assistant-host reporting test registers Worker routes, real credential
middleware and request logging with strict direct Report/Get/List operations.
It preserves complete host input/output, unavailable providers, absent-field
omission, private headers and log redaction. Protocol 2 calls Report once with a
supplied lower validation refusal. Get/List results are independent supplied
facts, without report-driven storage state.

Core tests retain actual validation and complete snapshot projection with fresh
host values. Admission service fixtures use independently allocated input,
normalized, proposed and stored hosts with distinguishable directories, so the
existing full argument comparisons expose lost or bypassed normalization.
The configuration-exchange compatibility test preserves its nine requests through
Report/Get/Configuration callbacks. Bootstrap and future-refusal inputs remain
complete; subsequent reads supply independent facts. Legacy responses retain
exactly two timestamps and no configuration header. Core executes the exact
bootstrap/future-observation decisions; service verifies success, refusal and
legacy sequencing. Store separately verifies real commits and fresh snapshots.
The shared capacity fixture contains only pure expectation helpers. Run the
selected HTTP/Core/Service owners without database or UniAuth fixtures:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -overlay=scripts/unit-overlay.json \
  -run '^(TestWorkerAssistantHostHTTP|TestWorkerAssistantHostReportValidationAndSnapshot|TestExchangeConfigurationAssistantHostCompatibility|TestWorkerAdmission)' \
  ./internal/server/worker ./internal/core/worker ./internal/service/worker
```

The [assistant-host test decision](../../.agents/notes/implemented/testing/2026-11-09-worker-assistant-host-http-test-owners.md)
records the protocol, Core and service proof owners. The
[configuration compatibility HTTP decision](../../.agents/notes/implemented/testing/2026-11-09-worker-assistant-host-configuration-http-test-owners.md)
records its separate wire and lower observations. Other Root and Worker
selections keep their own infrastructure requirements.

### Worker configuration service tests

The selected `internal/service/worker` configuration tests execute revision
parsing, normalization and service coordination with controlled snapshots,
transaction completion and the directly invoked Core configuration operation.
They preserve exact arguments, context and transaction-bound DAO identity,
refusals, cancellation, error chains and result suppression. Run this subset
without database or UniAuth fixtures:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -overlay=scripts/unit-overlay.json \
  -run '^TestWorkerConfiguration(Validation|UsesControlled|Refusal|Completion|Constructors|AuthorityService)|^TestHistoricalConfigurationCandidateAdmissionAndRead$' \
  ./internal/service/worker
```

The PostgreSQL Worker contract suite retains actual configuration write/read
independence after Task storage is removed. Historical configuration repair and
revoked-Project policy execute in Core with controlled DAO facts; candidate
admission and supplied read results execute in the service subset. The Store
contract suite retains actual stored 65 values, grant revocation, JSONB args,
committed repair and fresh readback. The [historical configuration decision](../../.agents/notes/implemented/testing/2026-11-09-worker-historical-configuration-test-owners.md)
records these owners. Core tests own bootstrap, cloud authority, no-op, update
and stale revision decisions; service tests coordinate supplied reads, writes
and report receipts. Store tests verify legacy and configuration persistence
across telemetry expiry and account isolation with real Reader and Writer
queries. Concurrent bootstrap, independent CAS and report-budget cases retain
their existing fixtures. The [configuration test decision](../../.agents/notes/implemented/testing/2026-11-09-worker-configuration-test-boundary.md)
records these proof owners.

### Identity service tests

`internal/service/identity` tests mock the directly invoked Core Identity and
Personal Team operations through private instance bindings. `New` binds the real
operations and `time.Now`. The complete ordinary suite clears database and auth
fixture variables and executes real service callbacks, completion handling and
UniAuth SDK HTTP transport.

Tests verify raw input and principal propagation, context and transaction-bound
capability identity, login consumption before upstream retrieval, shared
user/Personal Team/session scope, partial login results, secret suppression,
completion precedence, device rate scopes and known-rollback collision retries.
EnsureUser and PatchUser tests retain strict rollback on domain refusals, account
initialization ordering, complete profile admission and fresh post-wait credential
checks. The normal credential API integration flow updates through both Cookie
and PAT, reads the committed profile independently and verifies a subsequent
native login restores upstream fields on the same account and Personal Team.
Actual SDK parsing, response errors, cancellation, provider discovery and profile
encoding remain with the service adapter. Microsoft identities in either
`microsoft:<tid>:<oid>` or `msft:<oid>@<tid>` form reach user persistence as
`msft:<oid>@<tid>`. Core Identity tests own the conversion, separator validation,
identity distinction and idempotence; service tests verify canonical keys reach
persistence and malformed keys fail before the user transaction. Core Identity
and Personal Team tests also own business admission, credentials, expiry and
device decisions. PostgreSQL Identity tests own SQL, current-row locks,
uniqueness, persisted fields and cross-DAO rollback. Migration 064 tests retain
actual old identity keys, account credentials and ownership, verify both input
formats reuse the migrated account, and prove malformed or colliding keys leave
users and the migration ledger unchanged. Controlled completion does not prove
persistence. The [authentication design](../../docs/design/daynight-auth.md#uniauth-一次性交接)
owns the receiver-first upgrade order and identity migration behavior.

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -timeout=5m -overlay=scripts/unit-overlay.json \
  ./internal/service/identity ./internal/core/identity
```

PostgreSQL receivers use the documented isolated database configuration and run
with `go test ./internal/core/store/postgres/identity ./internal/core/store/postgres`.

The [Identity test boundary decision](../../.agents/notes/implemented/testing/2026-11-09-identity-direct-operation-tests.md) records the operation defaults and proof ownership.

### OAuth HTTP tests

Public authorization and token lifecycle tests run with their HTTP adapters,
real local Service and Core components, sockets and controlled DAO facts. They
cover browser binding, code and token hash association, concurrent redemption,
lost responses, refresh, replay and revocation without PostgreSQL. Controlled
transaction outcomes and supplied rows are logical test facts, not persisted
readback. Root tests retain the assembled public profile, MCP identity and error
page wiring.

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL \
  go test -p=2 -count=1 -timeout=5m -overlay=scripts/unit-overlay.json \
  ./internal/server/oauth/authorization ./internal/server/oauth/token \
  -run 'TestOAuth(AuthorizationControlledHTTP|TokenLifecycleControlledHTTP)$'
```

The [component ownership decision](../../.agents/notes/implemented/testing/2026-11-11-go-component-test-ownership.md)
records the test boundary and cost constraints.

### OAuth service tests

The complete `internal/service/oauth` suite runs without PostgreSQL or UniAuth
fixtures. Clients and Authorizations use instance-owned direct Core/business
operation bindings; tests execute their actual construction, callbacks and
orchestration with independently configured callback errors, transaction
completion and final writer errors. Scope capability identity, exact arguments,
ordering and result/secret suppression are checked without a storage model.
Authenticator access admission also executes the real Core with a controlled
credential-family DAO, checking token hash, resource, scope, UTC time, identity
and refusal.

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -timeout=5m -overlay=scripts/unit-overlay.json \
  ./internal/service/oauth
```

Core tests own metadata projection and freezing, code binding/expiry and
credential issuance rules. Registration HTTP tests retain real request/response
handling with controlled operation results. PostgreSQL DAO and AuthorizationScope
tests retain actual advisory/row locks, fresh time, client pinning and cleanup,
large JSONB readback, rollback and single-connection release. The service tests
retain session rechecks, DCR pin ordering, code retry/admission and transaction
completion precedence. MetadataFetcher keeps its real TLS/HTTP, DNS, cache,
concurrency and cancellation tests. The
[operation-boundary decision](../../.agents/notes/implemented/testing/2026-11-10-oauth-service-operation-boundaries.md)
records ownership, receiver migration and verification cost.

### Bot management service tests

The `internal/service/bot` suite executes actual snapshot/write callbacks,
normalization, model catalog protocol and request coordination, deletion
stop-proof validation and Session/file cleanup. Private instance operations
supply direct core creation, read and selection results and deletion decisions.
Production constructors bind the real implementations and retain `time.Now`;
strict unit expectations verify context, principal, identifiers, inputs,
current-scope capabilities, call order, completion outcomes and error chains.
Ordinary tests clear database and UniAuth fixture variables and do not simulate
persisted state. OAuth credential scenarios use the real Bot operations with
controlled DAO facts, including the deletion credential recheck after mutation.

Model catalog tests execute request encoding, response identity association,
result validation and decoding, pagination, catalog consistency checks, bounded
accumulation, the total native-discovery deadline and error propagation.
`modelRequestFunc` supplies `modelRequester.Request` with controlled messages and
errors. Production application wiring supplies the authenticated Worker requester
through `NewWithNativeDiscovery`; these unit tests do not establish network or
HTTP transport behavior.

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -timeout=5m -overlay=scripts/unit-overlay.json \
  ./internal/service/bot
```

Core Bot tests own replay, configuration/default/native and deletion rules.
PostgreSQL Bot/Session tests retain real locks, credential rechecks, preferences,
rollback, cleanup visibility and precise persisted versions. Local archive tests
retain actual orphan-file removal. The independent API integration suite owns representative normal flows
through the assembled server.
See the [Bot service test boundary decision](../../.agents/notes/implemented/testing/2026-11-09-bot-service-test-boundary.md).

### Bot runtime service tests

The `internal/service/bot/runtime` suite executes the Runtime transaction and
callback orchestration with controlled direct core operations. `NewRuntime`
binds instance-owned Engine, Operation, Bot authorization and Access operations
to their production implementations; unit tests supply independent operation
results and errors without running core business rules or preparing a database.
Opaque Operation and Access values preserve the identity passed to callbacks.

The tests verify current and parent credential checks, Bot/Session ordering,
prepare/check/work short-circuiting, exact context and scope propagation, error
preservation and exactly one operation close. A constructor test checks the
production bindings, Engine receiver, writer and deferred operation lifetime.
The Session service still owns transaction completion and `Operation.Finish`.
Run the ordinary module without PostgreSQL or UniAuth fixtures:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -timeout=5m -overlay=scripts/unit-overlay.json \
  ./internal/service/bot/runtime
```

Core tests retain Bot authorization, parent-credential policy and Engine stop
admission. The existing PostgreSQL Session lifecycle test checks the inserted
Bot/parent association before a grant can overwrite it, then checks the live
connection. It verifies a distinct current PAT remains valid after the
parent PAT is physically removed, and retains transactional cleanup and rollback.
These physical assertions run with isolated PostgreSQL through the module check;
mocked outcomes cannot establish them. The
[Runtime test boundary decision](../../.agents/notes/implemented/testing/2026-11-09-bot-runtime-service-test-boundary.md)
records the operation bindings and proof ownership.

### Team service tests

The `internal/service/team` suite executes Team scope callbacks, completion
handling and invitation/eligibility orchestration with strict direct-operation
mocks. `NewTeams` binds private, instance-owned Team admission, business and
eligibility operations to their production implementations. Unit fixtures supply
independent domain facts, errors and completion outcomes, checking principal,
raw input, IDs, context, transaction capabilities, calls and required order.
They do not run core business rules, construct an in-memory Store or prepare
identity/database fixtures. The test binary clears database and UniAuth fixture
variables before its ordinary suite.

Run the module without PostgreSQL or UniAuth fixtures:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -timeout=5m -overlay=scripts/unit-overlay.json \
  ./internal/service/team
```

Completion tests retain allocated-ID errors, staged snapshot refusals and the
method-specific result contracts. Invitation acceptance uses a completed read
snapshot followed by an independent Team write scope; eligibility refresh uses
that write scope and runs only after the lower mutation succeeds. Direct-member
service tests execute initial admission, confirmed independent initialization and
final member/eligibility completion, including partial-account retention and
fresh post-member-wait credential checks. Its normal integration flow creates a
Team, adds an external identity through real PAT authentication and rereads the
exact member UUID, profile, version and timestamps. Core tests own direct-member
convergence and role conflicts, lifecycle, last-admin, invitation and post-lock clock decisions. PostgreSQL
owners verify current facts after Team/invitation locks, SQL failures, consumption,
rollback and fresh persisted readback. `PersonalTeamID` belongs to Identity.
The [Team test boundary decision](../../.agents/notes/implemented/testing/2026-11-09-team-service-test-boundary.md)
records these proof owners and the distinct read/completion behavior.

### Business rules and DAO mocks

The [test-writing rules](../../docs/writing_tests.md) choose component boundaries
by behavior and total cost. Core tests execute business rules over constructed
domain facts and required controlled dependencies. Service tests execute their
own assembly, orchestration, transaction coordination and shared resource
lifetime; Server tests execute the real HTTP adapter. Inexpensive, deterministic
Service and Core collaborators may remain real. Control only the capability
needed for expensive or unpredictable dependencies or precise outcomes, errors,
blocking and cancellation. Go tests live with their tested object; consider splitting files
by cohesive responsibility after about 1000 lines and consolidate small helpers.

Check exact principal, IDs, inputs, context, transaction-bound capabilities,
expected calls and order, results and error chains. Service transaction callbacks
still execute; lower operation results, completion and cleanup errors are
independent facts. Assembly and lifecycle tests control collaborators and external
resources while executing production construction, wiring and the real lifetime
mechanism under test. Shared types and pure data remain ordinary values, and pure/protocol
code executes at its owner. Store tests own physical database mechanisms; API
integration tests own representative normal assembled flows. Unconfigured access
must fail immediately. Selections designed without a database must execute
without `DAYNIGHT_TEST_DATABASE_URL`; real database mechanisms use an isolated
PostgreSQL instance.

The regular `internal/server/task` suite exercises production routing, HTTP
parsing, credential middleware, DTO conversion, error mapping and the server-owned
encoder or response writer. Task reads, writes, observations and sync also run
with real Task components over narrowly controlled snapshot and project-write
capabilities. Step and Thread HTTP scenarios also use real services and narrowly
controlled DAO facts, with local files for attachment effects. Other scenarios
use direct Task, Step, Thread, Search or Sync operation mocks where precise
results are needed. Configured calls are required;
extra or unconfigured calls fail. Project/Task facts and principals are synthetic
inputs, without an in-memory business state machine or full-application startup.
The package's `!stress` TestMain clears `DAYNIGHT_TEST_DATABASE_URL` and
`DAYNIGHT_TEST_UNIAUTH_FIXTURE` before every regular suite execution, including
the complete module coverage check. The other package binaries still receive
their required infrastructure; an accidental Task HTTP fixture dependency fails
rather than borrowing it. The separate stress suite excludes this TestMain. Its Task assignee sample uses
the real application and isolated PostgreSQL to observe HTTP timing, the actual
production queries and their plans.
`RequestAuthentication` supplies the real Bearer, cookie and Origin policy with a
controlled credential operation; account and login routes retain the complete
`Authentication` adapter. From this module, run:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -overlay=scripts/unit-overlay.json ./internal/server/task
```

A mock committed or unknown result describes the supplied service outcome;
actual SQL, locks, snapshot consistency, commit acknowledgement and persistence
belong to store tests with isolated PostgreSQL. The regular HTTP suite retains
the real Step socket read-timeout proof. It checks the constructed 15-second
production default, then selects 200 milliseconds for that handler instance
through the same JSON decoder and body reader. The test verifies the timeout
response, request ID, connection closure, handler completion, zero Step calls
and `not_committed` log outcome. Capacity workloads retain their full fixture
only behind the separate `stress` build tag.

Project settings and encoded-budget validation, Attachment input validation and
invalid login scopes use input-only fixtures. Existing fixture-based domain
tests outside the Task HTTP suite remain part of the module check. Command
process tests use the startup/shutdown entry. Their mechanism and ownership are
determined by the test-writing rules.

The ordinary `internal/service/webhook` suite uses narrow transaction and DAO
mocks. The mocks return explicitly configured facts and projections, record
requested writes, and fail on unexpected access. They do not simulate a database
or interpret recorded writes as committed state. Time-dependent cases provide
`ObservedAt` and `RecordedAt` values, and concurrent cases synchronize actual
callback entry, cancellation and drain through channels. Call ordering is scoped
to a logical operation or an explicit cross-operation barrier.

From this module, run the database-independent suite with:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL go test -race -count=1 ./internal/service/webhook
```

The `internal/server/webhook` suite exercises management and history mappings
through the real registrar, service and core with controlled DAO observations.
Its supplied delivery generations do not demonstrate recovery. Root's ordinary
`TestWebhookRuntimeRouteAssembly` retains the real `New` and `Start` wiring.
`webhooktest` selects the full application management and ACL cases; physical
recovery and no-redelivery run separately with `stress,webhooktest`. The shared
application fixture is available under `stress || webhooktest`.

Capture source facts and producer invocation belong to their Task, Step, Thread
and Worker owners. PostgreSQL tests retain the real operation fences, actor
reads, multi-record rollback, source/capture atomicity, lease and retention locks,
commit acknowledgement loss and fresh-process readback. The startup/shutdown
check also runs `TestWebhookRunnerAbruptProcessRecovery` in
`internal/service/webhook` with `-tags=webhooktest`: committed claim/admission exit, real TLS response before finalization, and discarded
finalize COMMIT acknowledgement followed by an enabled Runner restart. This
focused process witness runs in the independent lifecycle job;
production-duration timeout and capacity stress cases remain separate. HTTP and protocol tests
own response mappings, request digests, headers, projections and authentication.
The [Webhook test ownership decision](../../.agents/notes/implemented/testing/2026-11-08-webhook-service-dao-mocks.md)
records the proof split; the earlier
[fixture construction decision](../../.agents/notes/implemented/testing/2026-11-08-go-fixture-construction.md)
preserves its original isolation rationale.

PostgreSQL integration tests own real SQL, constraints, locking, commit and
rollback, persisted readback and authority or version changes across operations.
HTTP and process tests retain their composition and protocol boundaries. Moving
a rule matrix does not remove these proofs or replace them with a single mock
call. Do not mock SQL strings or implement a second in-memory database to test
business rules.

The complete `internal/core/session` suite uses synthetic domain facts and
narrow DAO, scope and transaction mocks. It exercises the real Session engine,
protocol validation and live state without PostgreSQL. Mocks supply explicit
Task, Bot, credential, Session, operation and terminal facts and capture proposed
write DTOs. A captured write is an intended operation, not proof of persistence;
transaction completion separately selects `committed`, `not_committed` or
`unknown`. Later reads and query decisions receive explicit scenario response
facts; recording a write does not automatically change those responses.

Bot registration checks its complete inserted identity, registration bytes and
durable initial Snapshot independently from the returned initial Snapshot. The
Bot package's expiry HTTP tests supply direct operation outcomes while retaining
routing, authentication, request parsing, response encoding and blocked-operation
barriers. They do not prove a database lock or rollback; the former Root fixture
also registered routes locally without calling `New`. The
[Bot expiry HTTP decision](../../.agents/notes/implemented/testing/2026-11-10-bot-expiry-http-test-owners.md)
records the proof allocation.

Session tests retain command admission and interaction-ID propagation,
owner/credential/version rechecks, generation and fence transitions, archive
and content identity, capacity boundaries, source ACK, cancellation and cleanup.
Controlled clocks and callback barriers exercise time and concurrency rules.
Private conversation data is checked at proposed durable writes. Store tests
separately prove SQL mapping, duplicate queries, locks, transactions, persistence
and deletion; Bot and Task service tests own cross-module orchestration.

From this module, run the complete database-independent Session suite with:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL go test -race -count=1 ./internal/core/session
```

The [Session test isolation decision](../../.agents/notes/implemented/testing/2026-11-08-session-test-dao-mocks.md)
records the complete proof allocation and the costs of the prior partial split.
The earlier
[control-rule](../../.agents/notes/implemented/testing/2026-11-06-session-control-rule-isolation.md),
[command-rule](../../.agents/notes/implemented/testing/2026-11-06-session-command-rule-isolation.md),
[load-state](../../.agents/notes/implemented/testing/2026-11-06-session-load-state-isolation.md)
and [Bot preflight](../../.agents/notes/implemented/testing/2026-11-06-bot-registration-preflight-isolation.md)
decisions preserve their original rationale. The
[server organization rules](../../docs/daynight-server.md#测试职责) own the stable
mock and transaction policy.

Project request validation uses a valid synthetic principal and a fail-on-access
store for UUID, creation input, pagination and entropy refusals that precede
storage. Real creation, readback, keyset paging and operational-error tests keep
PostgreSQL. The [Project validation decision](../../.agents/notes/implemented/testing/2026-11-06-project-request-validation-isolation.md)
records the input and error-chain guarantees.

Task request tests separate service preflight from candidates that require a
stored Task. Preflight rejects before storage; `PrepareUpdate` and `PrepareStatus`
tests use `TaskWriteDAO` expectations for reads, version order, results and error
chains. Service orchestration uses the same interface boundary for permission,
state, proposed writes and transaction completion. Store tests retain real scope,
query, locking, snapshot, commit and rollback observations. The
[Task validation decision](../../.agents/notes/implemented/testing/2026-11-06-task-request-candidate-isolation.md)
records the read-before-validation distinction.

### Attachment service and store tests

The complete `internal/service/attachment` suite"
through "including during complete module validation", with:

The complete `internal/service/attachment` suite uses synthetic principals,
Project and Task facts and controls directly invoked Project-read, path-conflict
and metadata read/write/delete operations through private instance-owned function
dependencies. The production constructor binds the real Core functions. Snapshot,
attachment mutation and directly used DAO interfaces remain controlled separately.
Each logical operation has an explicit call plan checking callback capability,
context, canonical addresses, inputs and order; unconfigured, extra or unconsumed
calls fail. Lower business DAO calls fail explicitly, so the fixture cannot
silently resume real Core operations. Operation and query results are configured
independently of captured writes. Callback execution and transaction completion
remain separate, including `committed`, `not_committed` and `unknown` outcomes.
The test binary clears `DAYNIGHT_TEST_DATABASE_URL` and
`DAYNIGHT_TEST_UNIAUTH_FIXTURE`, including during complete module validation.

Run the complete suite without database or authentication fixtures:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -timeout=5m ./internal/service/attachment
```

Service tests retain admission and call order, exact canonical addresses,
metadata and byte propagation, error chains, completion facts, cancellation,
upload leases and transfer cleanup. Real temporary files and permits remain
where the assertion concerns their use and lifetime. The content reader still
crosses the actual 5 MiB boundary; test-local fixtures do not reduce production
limits or timing defaults.

Core Attachment tests retain exact conflict-query Project/Task/context forwarding
and metadata write/delete cancellation context, input, one-call and error-chain
assertions. The independent Core Project read receiver retains the original
Attachment principal, Project ID, context and complete inherited access result.

PostgreSQL attachment DAO tests own SQL mapping, upsert identity, pagination,
literal wildcard prefixes, legacy metadata and affected-row failures. Root
PostgreSQL scope tests own actual Task and Project deletion barriers, concurrent
grant removal, transaction completion and readback after file publication or
backend loss. Local storage tests own sibling namespace byte isolation and
pruning, native case behavior, target gates, old readers and transfer publication.
The [Attachment service ownership decision](../../.agents/notes/implemented/testing/2026-11-09-attachment-service-test-ownership.md)
records the proof allocation. Measurements include these receiving packages;
a shorter service-package time alone does not establish a faster complete job.

### Attachment HTTP tests

The `internal/server/attachment` suite assembles the real HTTP, authentication
and attachment service adapters with controlled identity facts and strict DAO
and scope callbacks. Existing route, request, header and response cases execute
without preparing PostgreSQL or a complete product login flow. Unconfigured
storage access fails explicitly; fixture writes do not simulate committed state.

Run the suite from this module with the unit Web-resource overlay:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE GOFLAGS='-overlay=scripts/unit-overlay.json' go test -race -count=1 -timeout=5m ./internal/server/attachment
```

Tests retain actual TCP body reading and local file storage when those resources
are the mechanism under test. The stalled-upload case uses the attachment
handler's test-local read duration through the same `NewDeadlineBody` path,
verifies `408 request_timeout`, no partial publication, capacity release and a
subsequent successful upload. Production route registration still initializes
the handler duration to the existing 60-second attachment deadline.

The real 5 MiB content boundary, fixed-length and chunked requests, path guards,
preview/download headers and error responses remain HTTP or native-resource
assertions. The consumed-body metadata failure case uses direct `PutRetained`
and `List` callbacks, controlled credential middleware and an actual TCP
connection to verify the following keepalive request. Existing store metadata
tests retain actual SQL, transaction and
unchanged-state readback. Root PostgreSQL scope tests retain physical admission
and deletion barriers; service tests verify the corresponding calls and resource
lifetime with controlled lower results. Process tests retain exact metadata and
bytes across restart. The
[Attachment HTTP ownership decision](../../.agents/notes/implemented/testing/2026-11-08-attachment-http-test-ownership.md)
records this correction of existing tests and their retained proof boundaries.

### Task service and store tests

Task service tests use synthetic domain inputs and controlled DAO, snapshot and
transaction boundaries. Unconfigured calls fail explicitly. Callback execution
and proposed writes remain separate from `committed`, `not_committed` and
`unknown` results; tests retain permission, version, error-chain, cancellation
and source-fact assertions. OAuth Thread tests retain the Task presence barrier
and subsequent credential refusal with controlled DAO facts; they do not model
a database lock or a credential changing during the wait.

The List coordination suite controls directly invoked project authorization and
Task read operations. It checks the original context, principal, canonical IDs,
snapshot-bound capability identity and call order. Domain faults are staged
until snapshot completion, whose failures suppress partial pages and refusals.
Pure `SelectList` planning and `ProjectList` encoding execute normally, including
actual cursor encoding errors. Core owns the original three assignment functions,
with all 360 combinations, complete returned Task data, pagination, Worker
inventory, historical assignment and version-3 cursor scope. Shared platform and
agent-permission service fixtures retain their DAO-based List scope.

The Create, Update and SetStatus preparation-failure witnesses control project
write authorization and the selected Task preparation operation inside the real
write callback. They check input and scope capability identity, call order,
error chains and completion facts. Core tests execute the preparation operations
against controlled failing reads; neither fixture represents persistence.

Run the service suite and receiving Core tests without database or UniAuth
fixtures from the module:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -timeout=5m ./internal/service/task ./internal/core/task
```

The [List test decision](../../.agents/notes/implemented/testing/2026-11-09-task-list-direct-operation-tests.md)
records the direct-operation boundary and retained query/cursor proofs.
The [write preparation test decision](../../.agents/notes/implemented/testing/2026-11-10-task-write-preparation-tests.md)
records the selected failure witnesses and their Core recipients.

PostgreSQL witnesses follow their implementation owners under
`internal/core/store/postgres/`. Domain subpackages test direct DAO queries,
mapping, constraints and locks. The root package tests its connection,
migration, scope, transaction completion, shared snapshot and cross-DAO
atomicity mechanisms, including partial-write rollback and process-exit
readback. Pure database-independent contract tests live in `internal/core/store`;
independent business rules use core or service mocks. The test environment owns
an isolated PostgreSQL instance and its cleanup. Store tests do not reproduce
complete service flows. API integration and product E2E retain their normal-flow
scope under the [test-writing rules](../../docs/writing_tests.md).

Step service tests retain the real 64 MiB codec boundary: 170 escaped descriptions
fit, 171 exceed the collection limit, and both Add and Update refuse before any
write. Graph and Sync tests separate physical dataset/query proof from service
coordination without stored-size admission. The [Task test ownership decision](../../.agents/notes/implemented/testing/2026-11-08-task-service-test-ownership.md)
records this correction of existing tests and the earlier fixture decisions.

### Go API integration

On Linux with Docker, prepare the production Web build from the repository root
and run the API suite from this module:

```bash
pnpm install --frozen-lockfile --store-dir .tmp/pnpm-store
pnpm web:build
cd packages/daynight-server
env -u DAYNIGHT_TEST_DATABASE_URL bash scripts/integration.sh
```

When the URL is unset, the runner owns a fresh PostgreSQL 18.6 container. An
explicit `DAYNIGHT_TEST_DATABASE_URL` must refer to the invoking test
environment's isolated instance, such as its fresh CI service or local validation
container. It must not select a development, shared or production database.

`scripts/integration.sh` builds the production `cmd/daynight-server` and the
CLI image validator from the current source, requiring Node 24 and the installed
workspace dependencies. It fingerprints the server, Web and CLI build inputs
and the packaged validator; the suite verifies the binary hash, Go toolchain and
race mode against the receipt. Local validation and main pushes use race instrumentation; PR and other
CI events use the same non-race policy as the module check. Unit resource
overlays are not used for this production binary.

The explicit `integration` build tag keeps these flows outside ordinary unit
test discovery. The runner selects `TestServerAPINormalFlows`,
`TestServerAPISessionNormalFlow` and `TestServerAPICredentialUsageNormalFlow`;
each test owns its real Server process, UniAuth gateway, login, PAT and isolated
resources. Task groups run sequentially with separate projects: lifecycle,
search pagination and dependency graph, property and Sync readback, Step
operations, Thread replies, Attachment bytes, personal Worker prompt
synchronization, and Worker claim/Agent discussion.

The application flows obtain a real S2S grant for the existing native user and
use API Bearer requests for profile, Team/member, Project, Goal/Task, Step,
Thread and protected Attachment operations. Readbacks retain the same resource
IDs, versions, authors, settings, progress, bytes and MIME through application
and native access. Public refresh, owner grant reads and revocation, explicit
reconnection and credential usage retain the same real family. The readonly
flow keeps the actual PAT-authenticated Worker channel and dispatches its HTTP
request through an S2S-issued API grant for that owner.

Webhook management uses an API grant to read the event catalog, create a
disabled endpoint with a Project subscription, read its operation and signing
key, rename and rotate using observed versions, and delete the same endpoint.
The reserved HTTPS destination receives no requests: disabled endpoints are
excluded from capture. This production HTTP flow verifies configuration,
current eligibility, operation identity, signing-key rotation and tombstone
readback. Actual delivery transport, retained payloads and delivery history are
verified by their existing Webhook mechanism tests, including the independent
startup recovery probe; this flow does not claim an external receiver ACK.

The Session flow creates an owner-bound Web Worker claim, registers a Session,
mints its Controller grant and performs WebSocket hello and synchronization.
HTTP current-state readback and native and API browser snapshots retain the
same identity, generation and native Session ID. A Controller timeline event
arrives through both browser WebSockets with exact content and source identity.
Go HTTP and WebSocket clients exercise the actual service and persistence
assembly. The Session flow also uploads a real first image chunk over HTTP,
completes validation using the packaged CLI image decoder and verifies the
original through resource and archive reads. The suite does not run CLI, browser
or Web test suites and contains no business boundary or fault matrices.

Startup, build and test execution have deadlines. Owned process cleanup stops
the Server before releasing its schema and storage and confirms authentication
process termination. The shell EXIT handler uses `integration-runtime.mts` to
reconcile owned process identities and the run's resources, including its local
database container. Failed termination or cleanup remains a failure and retains
the affected run directory; successful cleanup cannot erase a test failure.

After interruption, run the independent reconciliation command from this module:

```bash
bash scripts/integration.sh --cleanup
```

Local reconciliation skips runs with a live runner. In CI it selects only the
current workflow run, job and attempt, then drains that run's owned children and
resources. It preserves the original command outcome and reports cleanup
failures. CI invokes it in an always-run step after API validation.

Safe evidence is retained under `.tmp/integration-results/<run-id>/`: `build.json`
binds source/fingerprint, binary hash, toolchain and race mode; `result.json`
records phase, command/test exit codes, run status and cleanup status. Successful
reconciliation of an unobserved command retains its null exit and interrupted
status. `run.log` contains streaming test output and bounded service diagnostics.
The independent `verify-api-integration` CI job prepares production Web resources
and its own PostgreSQL service, runs this suite and reconciles its resources,
then uploads only these JSON and log files as `daynight-server-api-integration`.
It waits only for change detection; Go module coverage runs in a separate job.
Private ownership/resource receipts, configuration, credentials, database files
and copied build artifacts stay outside the evidence directory.

The job is selected for server inputs, the CLI validator build inputs and the
production Web build inputs used by the Server: Web source, resources and build configuration, root Node
configuration and dependency patches. CLI-only changes keep their own checks.
The final gate requires actual success whenever API integration is selected.
The [API integration decision](../../.agents/notes/implemented/testing/2026-11-09-independent-go-api-integration.md)
records this scheduling and resource ownership.

The runner's six process and cleanup unit tests require Linux `/proc` process
identities. The independent Linux API job runs them as a required, bounded step
before production Web preparation and API flows. Run the same tests on Linux
from this module without PostgreSQL or a production Web build:

```bash
node --test scripts/integration-runtime.test.mts
```

They verify actual process exit and signal escalation, PID reuse protection,
owned-child cleanup, retained command and cleanup failures, interrupted runs and
directory removal recovery. The portable `scripts/check.sh` entry retains its
ordinary tool tests; these Linux runtime cases retain their separate
responsibility from the API normal-flow suite.

### TaskSync lock and time windows

TaskSync lock-wait regressions in store tests use a named 20-millisecond overlap
with real PostgreSQL transactions. They observe the waiting transaction blocked
by the held Project transaction's exact backend PID, then poll the database clock
with a bounded deadline until the overlap has elapsed before releasing that
lock. The old snapshot must retain committed versions while its observation
time crosses the uncommitted write's window; subsequent delta reads must include
both committed writes in timestamp order. Initial fixture rows share a database
timestamp so setup latency cannot exclude either row from the short baseline
window. Service tests separately control exact DAO windows and overlap admission.

The production overlap and the independent 10-second, 30-second and nanosecond
window cases remain separate. The [timing decision](../../.agents/notes/implemented/testing/2026-11-06-task-sync-lock-window.md)
records why database clocks and lock observations are required together.

### HTTP scenario ownership

Root `internal/server` unit tests assemble actual modules, routes and HTTP
authentication over controlled collaborators. Server assembly cases and their
shared fixtures are grouped in `server_test.go`, `server_auth_test.go`,
`server_oauth_test.go`, `server_routes_test.go` and `server_fixture_test.go`.
Runtime tests and tagged Webhook application tests retain their separate owners
and build constraints. Root route tests check the registered patterns and
unauthenticated refusals, including protected method fallbacks. A source binding
check supplements the live identity and Session lifecycle witnesses for the
shared Authentication instance. The MCP Step lifecycle uses a
focused Entry host with controlled operations; its Service, Core, Capturer and
Store receivers retain lower coordination, rules and persistence proofs. Other
DAO/scope fixtures supply fixed domain records, query results, proposed writes, call counts and transaction
completion as explicit test inputs. Callback writes do not determine future reads or simulate committed
state. Configuration validation and startup ordering live with Config and App;
`internal/server/webui` owns the static route and request-log matrix. Root retains
actual `New` route composition, API protection and representative shell and asset
wiring. The `internal/server/auth` tests of UniAuth identity, result/browser
binding and SDK wire loss use real Authentication and Identity components with
controlled DAO facts, an isolated gateway, real proxy and sockets. Root retains
the production `New` and configured callback assembly proof. Prepare the pinned
auth fixture as described in [validation](#validate).

Native HTTP/TCP, MCP SDK, WebSocket, Session Engine, files and runtime lifecycle
remain real where they are the mechanism being verified. Root HTTP control and
WebSocket traffic share one actual application and Engine. Runtime tests group
lifecycle, metrics listeners and transport boundaries by responsibility; server
tests own application shutdown ordering. The metrics handler retains its direct
write failure test. These cases use controlled DAO facts and do not require a
database; listener, deadline, relay, file and retry observations remain real.
Startup, channel, serialization and shutdown cases retain their private composition
observations and capacity boundaries. Store tests own actual SQL, database-clock expiry after
locks, transaction outcomes and committed readback; process tests own complete
entry-point drain and restart persistence. The
[root DAO ownership decision](../../.agents/notes/implemented/testing/2026-11-09-root-http-test-dao-ownership.md)
records these fixtures and the distinction between logical and physical evidence.

Domain packages own their HTTP adapters. Project and Team organization scenarios
use their real registrars, authentication parser, Service and Core with narrow
controlled DAO facts. Root retains actual `New` fallback, health and cross-route
projection proofs; supplied query results and completion do not prove persistence.
Task HTTP tests use real Task components or controlled operations as each
scenario requires; Session HTTP tests control directly called service/use-case
results. Both retain actual credential middleware, HTTP encoding, response loss
and socket/resource handling where those mechanisms are under test. Their
[Task](#business-rules-and-dao-mocks) and [Session](#session-http-tests) guides
identify those boundaries. Attachment
fixtures retain their own [protocol and native-resource scope](#attachment-http-tests).
Normal assembled API flows run separately in `cmd/integration_tests`, including
`TestServerAPINormalFlows` and `TestServerAPISessionNormalFlow`.

Shared scenario bodies have one owner; distinct internal composition assertions
remain in the root package. The
[scenario consolidation](../../.agents/notes/implemented/testing/2026-11-06-server-http-proof-owners.md)
preserves the original rationale. The
[Go dependency decision](../../.agents/notes/implemented/testing/2026-11-08-go-test-dependency-boundaries.md)
owns responsibility boundaries; the
[Session use-case decision](../../.agents/notes/implemented/testing/2026-11-09-session-http-use-cases.md)
records the direct Session binding and retained proofs.

### MCP transfer service tests

The `internal/service/mcptransfer` suite controls private transfer DAO and
transaction boundaries. `Lifecycle` also controls its direct Core `Create`
operation, while Core tests own its active-slot matrix and duplicate behavior.
Other direct Lifecycle operations still execute Core through DAO expectations.
Reads, proposed writes, operation results and completion outcomes are explicit,
independently constructed facts; recorded writes do not supply later reads or
simulate persistence. Unconfigured calls fail, and the test binary clears
database and UniAuth test variables.

Uploads control the directly invoked attachment operation through an
instance-owned private admission adapter. `NewUploads` still binds that adapter
to the real attachment service, with the same public constructor and production
renewal interval. Tests execute the actual transfer lifecycle, permits, files,
gates, cancellation and drain, lease renewal, chunk stream and hash verification.
The real 5 MiB file limit, ten 512 KiB chunks, inline 512 KiB and excess inputs
remain exercised.

Run the complete service suite without database or authentication fixtures:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE \
  go test -race -p=2 -count=1 -timeout=5m -overlay=scripts/unit-overlay.json ./internal/service/mcptransfer
```

PostgreSQL tests retain actual receipt/reservation atomicity, failed final writes,
authority replacement, late receipts after credential revocation and Project
lifecycle lock order. Core owns exact JSON binding equivalence, including extreme
exponents tested in a real bounded subprocess. The startup/shutdown entry runs
`TestMCPTransferCrossProcessCrashRecovery`: a child holds a real private gate
around an unreceipted orphan; cleanup must refuse while it lives, and a fresh
Lifecycle subprocess reclaims the object and releases accounting after the
writer is killed. This is a process-mechanism witness in the existing lifecycle
job. Normal assembled API flows retain their separate integration entry.

The [MCP transfer ownership decision](../../.agents/notes/implemented/testing/2026-11-09-mcptransfer-test-ownership.md)
and [Create boundary decision](../../.agents/notes/implemented/testing/2026-11-10-mcptransfer-create-test-boundary.md)
record the proof allocation. Measurements include receiving Store, core and
process work; supplied receipts and completion outcomes are not evidence of
physical persistence.

### MCP protocol tests

`internal/server/mcp` tests execute the actual Entry, HTTP transport, SDK,
schemas and tool response encoding. Most use controlled direct service/use-case
operations; Project, Team and Invitation organization scenarios also execute
real Service and Core with controlled DAO facts through a host registering only
their adapters. Bot's completed-response loss test also uses real Service and
Core, the SDK and socket through a Bot-only host; its later reads use explicitly
supplied DAO facts, not persisted readback. The Root MCP and REST Bot lifecycle
retains shared application construction. Entry OAuth tests retain access identity and stable grant authority across tokens,
request reauthentication and refresh-token refusal. Root retains default OAuth
admission, Team wiring and REST exclusion. Principals and domain results are
explicit facts; operations verify arguments, context, authority and calls.
Unconfigured calls fail independently
of the tool's error response. No Task state or database persistence is simulated.
Task query registration accepts controlled list and graph observation operations;
its Tasks dependency still serves ready and dependency reads. The Step lifecycle
uses a focused Entry host and controlled operations, retaining both protocol
versions and per-request checks. Thread scenarios use real Service and Core
with controlled DAO facts and retain completed-response loss. Lower receivers
retain business and DAO responsibilities. Attachment and transfer scenarios use
real services, Core, local files and the SDK through a host registering only
their adapters, with controlled DAO facts. They retain pagination, deletion,
upload response loss and download snapshot observations; Root retains the
assembled authentication and revocation path. The ordinary test binary clears
`DAYNIGHT_TEST_DATABASE_URL` and `DAYNIGHT_TEST_UNIAUTH_FIXTURE` before running;
the separate stress build retains the database variable for its physical witness.

Run from this module with the unit resource overlay:

```bash
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE go test -race -p=2 -count=1 -timeout=5m -overlay=scripts/unit-overlay.json ./internal/server/mcp
```

The suite retains real MCP framing and SDK parsing, schema registration errors,
exact RPC ID and Task write-response boundaries, HTML escaping, compiled-input
limits, request cancellation, shutdown and input/content admission. The native
stalled-body test asserts the 15-second production default and uses a
200-millisecond instance duration through the same logical and socket deadline.
Global definition mutation tests remain isolated from concurrent registration.

Service tests own write-response admission, ordinary Team/member batch-page
selection and scoped cursors, transfer receipts and deleted-project refusal.
Read pages do not use envelope-size callbacks, prefix trimming or byte refusal. Core and Store retain their rules and
actual SQL, transactions, rollback, persistence and authorization rechecks.
Protocol mocks supply completion facts; they do not prove physical completion.
The [MCP ownership decision](../../.agents/notes/implemented/testing/2026-11-09-mcp-use-case-test-ownership.md)
records the proof split and alternatives. Normal assembled flows retain the
separate API integration entry.

### Session HTTP tests

The regular `internal/server/session` suite executes actual routes and
`RequestAuthentication`. Adapter cases use direct typed Session use-case
callbacks, supplied through the private `serviceCalls` binding. Protocol
component cases assemble the real Session service, engine and identity service
with controlled DAO facts; they retain channel fences, serialization, startup
evidence and terminal recovery. Tests verify context, canonical addresses,
fences, inputs, outputs and call counts without a database or gateway.

Configured calls are required, and unknown, extra or missing calls fail.
Foreground operations have finite expected counts; repeated channel polling is
scenario-declared. Callback barriers and cancellation observe each operation's
lifetime without a global goroutine order. Supplied DAO facts and replies remain
independent of captured requests. A mock result does not establish physical
transaction persistence.

Run the regular suite from this module without database or UniAuth fixtures:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL -u DAYNIGHT_TEST_UNIAUTH_FIXTURE go test -race -count=1 -timeout=5m ./internal/server/session
```

HTTP parsing, WebSocket Ping/Pong and event delivery, generation changes,
revocation/deletion closure, pending upgrade drain and TCP body behavior retain
their actual transport. Archive callbacks exchange an opaque preflight
reservation, an upload operation or content bytes with a separate closeable
lease. Identity and exactly-once closing are checked. Actual body reading,
backpressure and the existing 16 MiB upload/readback remain socket observations;
archive eligibility, integrity and storage rules retain their core owners.
Production intervals and the 120-second archive policy keep separate default
checks; opt-in full-duration archive probes remain under [Coverage](#coverage).

Service tests control lower work and transaction completion before the finisher.
Core tests retain preflight-before-residency and terminal initial-delivery rules;
Store tests retain failed-disconnect rollback, physical connection return and
zero legacy content rows after native ledger writes. Fixture shutdown drains
actual routes and validates callback/lease completion. Normal shutdown permits
post-drain HTTP `429` checks; cleanup cancels remaining request lifetimes.
Intentional clean refusals use an exact cause matcher, so every joined cause
must match and unexpected errors or unfinished drain still fail. The
[Session use-case decision](../../.agents/notes/implemented/testing/2026-11-09-session-http-use-cases.md)
records the proof allocation and alternatives.

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
normalized. Parity and comparator faults share one historical replay and one
snapshot; fault mutations roll back, with explicit restoration of nontransactional
sequence state. The snapshot version must match the latest migration, so every
migration change requires refreshing and verifying the snapshot.

The PostgreSQL root test package shares only its management connection pool,
closing it after all schema cleanups. Operational pools and schema namespaces
remain fixture-owned. `internal/core/store/postgres/testdata/testutil` shares
fixture creation and database observation through existing store contracts and
explicit pools. Backend-opening factories remain in consuming test packages;
external DAO tests pass `postgres.Open` to the shared factory helper. The shared
helpers do not import the root implementation. Same-owner tests share
these helpers and retain their independent transaction and cleanup conditions.
The [ownership decision](../../.agents/notes/implemented/testing/2026-11-09-postgres-test-ownership.md)
records directory and consolidation choices. Selected error matrices reuse
restored or read-only fixtures; [the preparation decision](../../.agents/notes/implemented/testing/2026-11-08-postgres-test-preparation.md)
records their isolation and expiry guarantees.

The Webhook DAO package groups schema-stable capture, delivery, history and
retention cases under explicit parent-owned schemas and native connections.
Case boundaries retain real commits and independent readers. Before reuse, the
fixture checks connection and auxiliary-backend release, compares all preserved
seed rows, truncates mutable tables and restores every sequence's captured state.
The final case also runs release and seed checks. Historical schemas, permanent
catalog faults and custom concurrent lifetimes keep their independent fixtures.
The [Webhook grouping decision](../../.agents/notes/implemented/testing/2026-11-10-webhook-dao-group-fixtures.md)
records reset ownership and failure behavior.

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

### Task Graph query validation

Store tests use real ordinary graphs to verify complete component selection,
one-level external context, original dependency arrays, snapshots and
cancellation. Graph and Sync reads do not query or admit stored node/edge
capacity. Service DAO mocks retain authorization, projection and error chains.
CLI and Web tests accept complete graph or sync responses beyond the former
1000-node and 5000-edge thresholds. The
[fixture preparation decision](../../.agents/notes/implemented/testing/2026-11-06-task-graph-fixture-statistics.md)
preserves the original statistics and topology rationale; current read
responsibilities follow the
[batch-read decision](../../.agents/notes/implemented/simplification/2026-11-09-task-canonical-batch-reads.md).

### Race instrumentation

Both coverage entries enable race instrumentation locally and on main CI. PR CI
runs without race and overrides an inherited `GOFLAGS=-race`.
The separate
`bash scripts/stress.sh` entry uses `-race` for local-only stress tests.
The fresh-process attachment test uses its test's race setting for the child
build and verifies it in the binary; other process tests may differ. The explicit
`testdata/testauth` fixture check is separate from the coverage run; use
`go test -race -count=1 -timeout=30s ./testdata/testauth` for its race validation.

### Coverage

`scripts/check.sh` and `scripts/startup-shutdown.sh` invoke `go-cov` v0.1.4 with
one checked-in configuration. Package and function thresholds remain 85% and
80%. `critical_blocks.fail` is false, so critical-block analysis is disabled.
Each raw profile passes an exact statement comparison strictly greater than
90%; exactly 90% fails. The comparator reads rows incrementally and deduplicates
coverage blocks without loading the complete profile into one string.

Each coverage invocation also retains the original `go test -json` bytes under
`.tmp/go-test-evidence/module/run-*/` or
`.tmp/go-test-evidence/startup-shutdown/run-*/`. Inspect `go-test.jsonl` when the
coverage summary omits a test's failure detail. `go-test.complete.json` records
the captured byte count and the Go process's exit code or signal; it confirms
complete capture, including a failed test run, rather than a passing result.
A missing marker means the log may be partial. `go-test.failed.json` records a
capture failure and prevents success even if another invocation publishes a
completion marker afterward. Later invocations use new
directories, preserving earlier evidence. The corresponding CI artifacts include
these files even when validation fails.

Capture preserves the same Go invocation, parameters and coverage calculation.
File or forwarding errors fail validation. The existing command supervisor owns
the coverage process group, with a 30-minute module bound and the existing
12-minute lifecycle bound; per-package test and CI job limits still apply.
The [failure evidence decision](../../.agents/notes/implemented/testing/2026-11-11-go-test-failure-evidence.md)
records why the raw stream is retained separately from the coverage summary.

Production packages have disjoint coverage owners:

| Entry | Tests and production coverage | Profile |
|---|---|---|
| `scripts/check.sh` | Ordinary module tests and every production package except `cmd/daynight-server` | `coverage.out` |
| `scripts/startup-shutdown.sh` | Tagged command tests; the command package's production statements | `startup-shutdown-coverage.out` |

Every production package belongs to one partition; no production files or
functions are exempt. Requiring both partitions to exceed 90% also requires
their combined statement coverage to exceed 90%. The module entry selects all
of its production packages for `-coverpkg`, preserving cross-package coverage
within that partition. The lifecycle entry measures the command package from
its own directory and vets its tagged tests. Neither entry relies on coverage
of its production code from the other job.

`scripts/validation-env.sh` supplies the common race policy and an absolute-path
unit-test Web resource overlay. The absolute replacement paths remain valid
when the command coverage run changes directory and its fresh-process test
builds a child from the module root. Production builds retain real Web assets.
Module tests require isolated PostgreSQL and Redis instances; command tests
require isolated PostgreSQL. Redis DAO fixtures use unique keys and remove them;
preparation failures fail validation. Package concurrency stays limited to two:
schema-isolated fixtures still share the database-wide migration advisory lock.
Both entries clear cached test results before their coverage runs.

Schema-stable Task DAO tests share one real Store per sequential parent test.
Each independent case resets mutable tables and sequence state before executing
its original transactions and persisted readbacks. Snapshot seeds and the
migration ledger remain intact; catalog-changing cases retain separate schemas.
The [Task fixture decision](../../.agents/notes/implemented/testing/2026-11-10-task-dao-group-fixtures.md)
records reset ownership and isolation limits.

`scripts/env.sh` places Go tools, caches and temporary outputs under this
module's `.tmp/`. The `verify-server` and `verify-server-startup-shutdown` jobs
use independent PostgreSQL services and upload their profiles separately.
Selected jobs must both actually succeed. Inspect results for the tested
revision; a local result does not establish a hosted result. The
[lifecycle decision](../../.agents/notes/implemented/testing/2026-11-09-independent-go-startup-shutdown.md)
records the partition and scheduling rationale.

Ordinary discovery excludes stress-tagged files. With an isolated database,
`bash scripts/stress.sh` runs its explicit stress workloads with race detection
and refuses a nonempty `CI` environment. Direct command-package stress runs also
need `startupshutdown` alongside their existing `stress` and, where required,
`webhooktest` tags.
The `internal/service/webhook` two-instance webhook takeover fixture (`-tags=stress,webhooktest`,
`TestWebhookTwoInstanceTakeoverAndFencingStress`) is selected explicitly by the
stress entry point. It uses a private deterministic capture
stream and verifies its first-slot admission before testing second-slot recovery
and late-result fencing; see the [fixture timing decision](../../.agents/notes/implemented/testing/2026-11-08-webhook-takeover-fixture.md).

Authentication integration prepares the pinned UniAuth gateway with
`scripts/prepare-uniauth-fixture.mts`. The fixture runs on loopback with
controlled external provider responses and owns its temporary resources. For
focused integration tests, source `scripts/env.sh`, set
`DAYNIGHT_TEST_DATABASE_URL`, then set `DAYNIGHT_TEST_UNIAUTH_FIXTURE` to the
output of that preparation script. Both coverage entries perform their required
preparation themselves. The UniAuth identity, browser binding and wire-loss
selection in `internal/server/auth` runs with the gateway fixture and
`DAYNIGHT_TEST_DATABASE_URL` unset. The complete auth package still requires an
isolated PostgreSQL database for its other fixtures:

```bash
env -u DAYNIGHT_TEST_DATABASE_URL go test ./internal/server/auth -run '^TestAuthentication(UniAuthIdentityAndCredentials|UniAuthBrowserBindingAndConsumption|RealUniAuthResultWireLoss)$' -count=1
```

The real archive upload and response socket deadlines
can be checked separately with
`DAYNIGHT_TEST_ARCHIVE_DEADLINE=1 GOFLAGS="-overlay=scripts/unit-overlay.json" go test -tags=stress ./internal/server/session -run '^TestStressArchive(Upload|Send)DeadlineReleasesCapacity$' -count=1 -timeout=5m`;
each test waits for the production 120-second deadline.
The shared fixture cleanup waits for process exit and reports forced termination;
an unconfirmed service, database-session or gateway exit retains dependent owned
resources. `scripts/check.sh` explicitly tests `testdata/testauth`, which `./...`
does not discover. The real wire-loss test in
[`auth_transport_test.go`](internal/server/auth/auth_transport_test.go)
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

Both Compose deployments select `/var/lib/daynight` as root and mount a
project-scoped `attachment-data` volume at its `storage` directory. Fresh-volume initialization
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
that prefix. The business-layer mapper owns the address rule; the generic
Storage interface remains bucket/path only. API/CLI
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
session/PAT or fixed API OAuth family check at HTTP admission and project membership in the pre-I/O
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
a project lock or mutate task ownership. Summary reads select only canonical
list fields and count visible saved task references through UUID joins. Detail
reads batch-filter those references by current project membership and
undeleted-task visibility. The
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
One summary query returns `limit+1` rows; the cursor follows the last returned
item when lookahead exists. The list does not fetch full telemetry or task
payloads. Write ingress owns structure, field, normalization and existing
capacity checks; snapshot reads consume saved canonical data without repeating
those checks or applying a domain response-byte budget. Normal scan, decode and
output errors propagate.

A report with valid `Daynight-Worker-Configuration: 1` or `2` has a 9 MiB
UTF-8 JSON body limit; a report without the configuration protocol retains
1 MiB. Unknown or repeated configuration headers are rejected before business
processing. Deploy the server and ingress with the 9 MiB limit before upgrading
Workers; a 413 from an older server or ingress indicates a capacity or version
mismatch. The separate 4 MiB telemetry, final Worker and accepted configuration
observation storage limits and transactional rollback remain in force.

Reports use closed Probe states, explicit unknown inventory and a full task
reference array. A known empty array is distinct from inventory that has never
been synchronized. Task titles, status and phase come from current owned claims.
Reports and reads use the store's canonical project access relation for the
authenticated user, merging owner Team membership and direct grants. Subsequent reads preserve
saved observations while applying current access and undeleted-task filtering
to both rows and counts. Completion or reassignment
does not erase an otherwise visible historical observation. Liveness and recent
visibility do not control claims or task state.

## Worker current monitoring

The account can store and read one bounded current observation per recent
Worker. The [contract](../../docs/spec/daynight-worker-monitoring.md) defines
its closed fields, diagnostic content, permissions and errors; the
[design](../../docs/design/daynight-worker-monitoring.md) explains storage and
failure isolation. Worker capture and Web presentation use the same contract
with independent lifecycles.

| Method | Path | Result |
|---|---|---|
| `PUT` | `/api/v1/me/workers/{workerId}/monitoring` | `200`, accepted or duplicate receipt |
| `GET` | `/api/v1/me/workers/{workerId}/monitoring` | `200`, current permission-filtered observation or absent state |
| `POST` | `/api/v1/me/workers/monitoring/query` | `200`, ordered summaries for 1–100 distinct admitted Worker IDs |

These authenticated routes accept no query parameters. The request owner comes
from the principal; an unknown, other-account or expired Worker returns 404,
including any failed admission in a batch. Stored observations expire after
one hour; reads and duplicate or rejected writes do not renew them. Detail and
summary responses have separate encoding budgets. Four CAS conflicts return
409, unavailable storage returns `503 monitoring_unavailable`, and an uncertain
write returns `503 monitoring_write_outcome_unknown`; callers must read back an
unknown result before deciding what to do. Current access filters associated
names, IDs and private details, including claim failure worktree paths, without changing the Worker's total capacity. Deploy all Servers that accept and preserve the optional field before strict CLI/Web readers, then enable Worker production. Before rollback to a reader or Server that rejects it, stop production and allow affected frames to expire naturally after 3600 seconds or be safely replaced without the field; do not delete keys, renew TTLs or replay uncertain writes.

Summary reads first admit the entire Worker batch and read only each bounded
Redis header. A current PostgreSQL snapshot rechecks Workers and projects the
reason references before deduplication. Public summaries contain fixed reason
codes and projection quality, never private references or hidden counts.

Set `DAYNIGHT_REDIS_URL` to a valid `redis` or `rediss` URL to enable monitoring.
The only supported URL query parameter is `db`; connection and retry limits are
fixed.
If it is empty, the monitoring API returns 503 while existing business APIs and
readiness continue; a nonempty invalid URL fails configuration validation.
The Redis connection is owned only by monitoring and is closed during shutdown.
See [Validate](#validate) for isolated Redis and PostgreSQL test dependencies.

### Monitoring format transition

The stored header uses strict format version 2; v1 and v2 servers cannot serve
the same monitoring data concurrently. If an independently verified empty
monitoring store has no remaining old writer, deploy all v2 servers and verify
them before deploying the Web consumer. A single absent Worker is not proof
that the store is empty.

When old data exists or its presence is unknown, make monitoring endpoints
return 503 and stop and drain every old PUT/CAS writer, including in-flight
requests. Leave heartbeat, Task, claim and cleanup channels available. Record
Redis TIME as T0 after the drain and keep writes stopped until Redis TIME is at
least T0 plus 3600000 milliseconds. Legal old frames then expire under their
original TTL. Deploy and verify all v2 servers, restore monitoring, and deploy
the Web consumer. Do not scan or delete keys, extend TTLs, or use a migration
or compatibility fallback. If the time or writer boundary cannot be verified,
keep monitoring unavailable. Corrupt or non-expiring data remains an explicit
storage error.

Rollback uses the same write drain and natural TTL wait for v2 frames, unless an
independently verified empty store permits a direct transition. This barrier
can interrupt monitoring for the full hour plus deployment and verification;
it does not stop Worker business operations. Production operations require
their own authorization.

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

An admin directly adds an external identity with
`POST /api/v1/teams/{teamId}/members` and exactly
`{expectedUserId,user:{externalUserId,profile?},role}`. The actor UUID must match
the principal; role is explicitly `admin` or `member`, and no query or version
is accepted. The shared external-user input permits an optional profile containing
only nullable name/avatarUrl fields. Existing account profiles are preserved.

A short original Team scope checks the credential, ordinary Team and current
admin before target initialization. The independent EnsureUser operation must
confirm its complete user/Personal Team commit before the final Team scope
rechecks credential, Team/admin and target membership. That scope binds the
existing identity and family DAOs to the same transaction, preserves the Team
prelock, refreshes eligibility atomically and checks fresh credential validity
after member contention. Native Session/PAT checks use their reader-compatible
SHARE capability; API principals use the fixed API tuple. A late refusal can leave
a complete target account, while membership and eligibility roll back together.
Invalid credentials in either phase return `401 unauthenticated`, including a
missing credential row; an absent Team returns `404 not_found`. Completion and
cleanup failures retain priority over either refusal.

Success is `200 {membership,added,actorRole:"admin"}` with the actual target UUID,
role, independent membership version and UTC timestamps. A new relationship
returns added=true. An existing same-role relationship returns added=false with
its original version and timestamps; a different role returns
`409 resource_conflict` without a membership write. Use the existing versioned
PATCH to change that role. Direct addition neither changes the Team metadata
version nor creates or consumes an invitation. Invitation acceptance still
explicitly adds member and retains its existing actor and consumption rules.

An ordinary Team admin can resolve an existing external identity with
`POST /api/v1/teams/{teamId}/members/resolve` and exactly
`{expectedUserId,user:{externalUserId}}`. It accepts no query or profile and
uses the same identity validation as direct addition. The current user credential,
expected actor and current Team admin are checked in the Team transaction.
Success is `200 {membership,actorRole:"admin"}`; membership is the existing
TeamMember or null when the identity or relationship is absent. Credential,
authorization, Team and transaction failures are not null results. The response
is no-store and does not echo the external identity. Resolution creates or changes
no user, credential or membership; later writes still require current authority
and the observed membership version.

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

Creation defaults to proposed and accepts an optional proposed/todo status, version 1, nullable execution/cancellation timestamps, allowAgents=false
and unrestricted requiredPlatform=null unless explicitly supplied. Its
assignedTo defaults to null; an explicitly supplied UUID must identify a current
project member in the creation transaction.
It rejects other creation states and caller-supplied timing and permission; platform creation accepts
null or windows/linux/macos. PATCH retains field presence separately from nullable value. Properties/PRs and both
dependency collections have explicit empty defaults. Updates require a positive
expected int64 version and at least one mutable field; omitted pointers preserve
values, while empty description/dependency/PR lists clear them.
requiredPlatform and assignedTo accept null to clear; other JSON null input is
rejected.
Dependencies are canonical sorted UUIDs, checked for duplicate identity,
self-reference, missing/cross-project tasks and cycles. Active/done metadata
candidates require all predecessors done or cancelled; proposed, todo and cancelled may have unfinished predecessors.

Ordinary tasks without active worker ownership retain the original
direct transitions across proposed/todo/in_progress/done without a mandatory stage and may enter irreversible cancelled. The project write
transaction acquires the project lock, rechecks membership, compares the exact
version and only then handles same-state. A current same-state request returns
the full current Task without a stored write; stale same-state conflicts. Actual
change increments once. Entering active/done requires all direct predecessors
done or cancelled, including external edges; reopening done refuses sorted direct active/done
dependent IDs. No dependent is changed. Status preserves requiredPlatform, assignedTo, PRs,
other task fields, dependency classifications and attachments. Claim-bound done atomically marks
the current worker completed; its owner and claim ID must match. Active execution
returns to todo only through release. Release removes current ownership; cancelled tasks cannot be claimed or withdrawn to todo.
Released todo tasks begin a new execution through eligible automatic acquisition, with
fresh claim and worktree IDs. The old four lifecycle routes are removed.

Execution timing describes the current attempt. Actual entry into in_progress
uses statement_timestamp() after the lock and clears the end; return to proposed or todo
clears both. In-progress to done preserves its nullable start and records an end;
proposed/todo to done records an end with null start. Cancellation records `cancelledAt`
and preserves both execution endpoints; done-to-cancelled does not erase its
completion time. Metadata and same-state preserve time.
No missing historical start is inferred. State, timing, version and update time
commit atomically. Details are owned by the [status architecture](../../docs/design/daynight-task-status.md).

Migration 014 converts historical proposed rows to todo, advancing only their
version/update time and preserving every other field, including timing. It
atomically changes the default, rows, CHECK and ledger; restart does not rerun it.
Applied historical migrations are immutable. A subsequent migration admits proposed again and sets it as the creation default, preserving all existing task rows, revisions, timestamps and materials.

Migration 028_task_assignment.sql adds nullable assigned_to and a partial
project/assignee/keyset index for undeleted tasks. All existing and soft-deleted
tasks receive NULL without changes to versions, business timestamps, properties
or execution identity. Migration 063 adds a full index with the same keys for
assignment reads through `task_resource_rows` and retains the partial index.
The full index includes deleted rows; queries still enforce effective deletion.
It adds storage and write maintenance, and its transactional build blocks Task
writes for a duration that depends on table size. Task, summary and graph
responses always emit assignedTo as null or a canonical local user UUID.

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
assignment filtering so established executions retain their ownership rules.
The [claim foundation](../../docs/design/daynight-worker-claims.md)
rechecks eligibility and ownership in the same transaction. PR order and duplicates
remain significant. Readiness changes do not advance dependent task revisions.

Expected refusals are returned only after the lock-only transaction succeeds;
transaction/cleanup failures preserve operational errors. Reads use an RR snapshot.
Task cursors use version 3 and bind project, type, parent, the resolved
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
cursors stay at version 1; older task cursor versions are refused.
The assignee filter is explicit and does not change automatic worker eligibility.

## Task observation

`GET /api/v1/projects/{projectId}/tasks/{taskId}` returns the complete Task body and a required `Daynight-Task-Epoch` UUID header on success. Project permission, the Task and epoch are read in one read-only repeatable-read snapshot; a failed epoch query or transaction does not publish a success. The endpoint retains its existing authentication, 404/410 and `no-store` semantics. Unauthorized responses do not disclose the epoch.

## Task-chain graph

`GET /api/v1/projects/{projectId}/task-graph?taskId={taskId}` requires one task UUID.
The service reads the project, checks target visibility and reads the complete
selected compact graph in one read-only repeatable-read transaction.
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
counts once; the summary requires total, proposed, todo, inProgress, done, cancelled, ready and blocked,
including zero values. `total = proposed + todo + inProgress + done + cancelled` and
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

Selected graphs retain all context rows and their original outgoing
dependencies, including references beyond the projection. Reads do not repeat
stored node/edge capacity checks or add an aggregate Project write quota.
Natural query, decode and encoding failures return no partial graph. Missing projects or tasks return 404; an authorized deleted target returns
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
for actual changes. Reads use pure `ProjectCollection`/`ProjectItem` projection
and ordinary JSON encoding without stored-field or collection-capacity checks.
MCP Step pages use one `limit+1` query and an explicitly compared parent version;
summary and full views retain the same item-count cursor. The shared MCP entry
does not admit successful read output by schema or bytes. Invalid write candidates, natural decoding
or encoding errors, database failures and failed transaction cleanup retain
their causes; the service never substitutes a partial or empty result.

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
safe response diagnostics. Step read service tests control Project authorization
and snapshot completion independently while exercising the actual parent gate,
DAO queries, paging and encoding; PostgreSQL tests own physical snapshot proof.
Step Add and content/status change service tests control Project write
authorization and collection admission while exercising the locked parent gate,
DAO writes, real encoding, capture and transaction completion. Core tests own
the corresponding collection decisions; controlled completion does not prove a
physical commit.
Core Step tests encode the fitting 170-description collection and the
overflowing 171-description Change candidate through the real codec. Service
tests forward the complete collection to controlled admission and exercise a
real encoding failure before writes; they do not measure capacity at that layer.
The focused change cases are `TestTaskStepsChange*`
and `TestStepsHTTPChange*`; move cases are `TestTaskStepsMove*` and
`TestStepsHTTPMove*`; deletion cases are `TestTaskStepsDelete*` and
`TestStepsHTTPDelete*`. Service Step cases run without a database:

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL go test -race -count=1 -timeout=5m ./internal/service/task -run '^TestTaskSteps'
```

After preparing the normal auth fixture and an isolated PostgreSQL database,
run the physical store and HTTP witnesses from this module:

```bash
source scripts/env.sh
export DAYNIGHT_TEST_DATABASE_URL='postgres://.../isolated-test-database'
export DAYNIGHT_TEST_UNIAUTH_FIXTURE="$(node scripts/prepare-uniauth-fixture.mts)"
go test ./internal/core/store/postgres/... ./internal/server/... -run 'Test(Transact|TaskSteps|Steps)' -count=1 -timeout=5m
```

Step text boundaries are checked at their respective owners. From the repository
root, `pnpm --filter @codetreker/daynight test test/cli/task-steps-text.test.ts`
runs the built CLI's ten-process text sequence against controlled HTTP responses.
From this module, the following commands exercise Core admission, Service
coordination, HTTP parsing and physical Store readback and rollback. The Store
commands require the isolated PostgreSQL database above; the other cases do not.

```bash
source scripts/env.sh
env -u DAYNIGHT_TEST_DATABASE_URL go test ./internal/core/task/steps ./internal/service/task ./internal/server/task -run '^(TestWriteReceiverRootTextSequence|TestTaskStepsTextLimitsOnAddAndChange|TestStepsHTTPTextAdmission)$' -count=1 -timeout=5m
go test ./internal/core/store/postgres -run '^TestTaskSteps(ConfirmedRollbackAfterEachActualSQLWrite|PartialWritesAndSuppressedRowsRollBack)$' -count=1 -timeout=5m
go test ./internal/core/store/postgres/task -run '^TestTaskStepStore$' -count=1 -timeout=5m
```

Controlled CLI responses and Service completion do not establish physical
persistence; the Store tests use actual SQL and read back the persisted state.

Maximum-resource HTTP tests use the `stress` build tag and run separately from
routine CI:

```bash
go test -tags=stress ./internal/server/task -run '^TestStressStepsHTTP(ExactCapacity|AddCapacity|ChangeCapacity|MoveCapacity|DeleteCapacity)Stress$' -count=1 -timeout=5m
```

The read case seeds legitimate bounded individual records, observes complete
64 MiB HTTP bytes at the maximum int64 version and checks the same content at a
one-digit version. Reading does not repeat write-candidate capacity admission.
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

The write codec admits both default/detailed message encodings at <= 65,536
bytes before commit. Reads select count-based pages and encode canonical fields
normally without message or page-byte admission. HTTP writes those escaped JSON
bytes without an added LF. Full bodies and names are never truncated.
Service operations have a 10-second ceiling with shorter parent deadlines taking
precedence; actual-clock advancement has a 100 ms sub-budget, and rollback uses
an independent 5-second cleanup context. These bounds do not claim a whole-handler
latency SLA.

POST success follows confirmed commit. A failed cleanup remains 500 even with a
nested business refusal. Unknown COMMIT returns 503 message_outcome_unknown;
clients keep drafts and must not automatically repeat POST. A post-commit
response failure is logged once at response phase without another append.
Clock-budget exhaustion returns 503 clock_not_advanced; an oversized message
write is 413 payload_too_large. Missing local messages are 404 message_not_found. Invalid or
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
Release removes worker and sessionStartup after confirmed source stop; Session and
archive history retain their own identities. Force withdrawal accepts
the exact version and matching active claim ID from its original owner
or a project admin who remains a member. It atomically clears worker, returns
todo, clears execution timing and sets allowAgents=false, preserving other
materials. Cancelled tasks explicitly refuse withdrawal. It requires no stoppedConfirmed and does not guarantee immediate
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
| `POST` | `/api/v1/projects/{projectId}/tasks/{taskId}/worker-claim/withdraw` | `200`, owner/admin clears active ownership, returns todo and disables automatic execution |

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
A retained worker is a typed active/completed claim object. Public
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

Task lists support `limit`, `cursor`, `type`, `parentId`, `status`, `ready`,
`allowAgents`, `platformSpecific`, `compatiblePlatform`, `assignedTo`, UUID
`workerId`, `tagIds`, `tagMatch` and `untagged`, once each. Type defaults to
`task` and can select `goal`; parentId
accepts `none` or a canonical UUID and is omitted for all parents. Goal lists
cannot select a nonempty parent. The ready, allowAgents and platformSpecific
filters accept literal `true` or `false`; compatibility accepts `windows`,
`linux` or `macos` and includes null requirements and exact matches.
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

List and ready selection accept comma-separated UUID `tagIds`,
`tagMatch=all|any` (default all), and literal boolean `untagged`. IDs are
canonicalized, sorted and deduplicated. `untagged=true` conflicts with nonempty
IDs; omitted IDs without untagged impose no tag predicate. Every requested tag
must exist in the current Project in the same authorized repeatable-read
snapshot used to select the page; missing, cross-Project or deleted tags return
400 `invalid_tag_filter`. SQL applies the tag predicate with existing filters
before ordering, pagination and priority/ready candidate limits. Each Task or
Goal matches its own associations. Cursors bind a SHA-256 digest of the
normalized IDs, mode and untagged state, keeping cursor size independent of the
selected set. Existing 24 KiB query, 48 KiB request-target and 16 KiB cursor
limits remain; no tag-count quota is added.

Task cursor version 3 includes type, parent and the resolved assignee scope; me and its concrete
UUID may share that scope, but another account's me cannot. Account-owned Worker
list cursors remain version 1.

The project-scoped task-assignees GET returns `items` and `unresolvedUserIds`
as non-null arrays. With no query it enumerates current members and assignees
retained by effectively visible tasks. Repeated `userId` query arguments select a bounded
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
Relevant sorted IDs appear in `error.details.taskIds`. Write input validation
returns 400 invalid_input with its cause. Stored properties are read as canonical
RawMessages without normalization or capacity checks; natural decoding, encoding,
database and other operational failures retain their original causes. No path
returns partial properties or silently repairs values. Cancelled
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

To inspect a failure, match its response `requestId` with JSON logs:

```bash
jq 'select(.request_id == "REQUEST_ID")' "$DAYNIGHT_ROOT/logs/daynight-server.log"
```

The same records are written to stderr. Submitted URLs, bodies, SQL and
credentials are excluded from logs.

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
go test -tags=startupshutdown -count=1 -timeout=10m -run '^TestAttachmentGrantRevocationWithFreshProcess$' -v ./cmd/daynight-server
# Explicit race evidence for both the test and its freshly built child:
go test -tags=startupshutdown -race -count=1 -timeout=10m -run '^TestAttachmentGrantRevocationWithFreshProcess$' -v ./cmd/daynight-server
```

A focused or dirty/overlay run is evidence only for its actual source, flags,
binary and environment; it does not replace both clean coverage checks or
hosted CI. The earlier `cmd/e2e_tests` built-process and installed-CLI scenarios
were removed. Their recorded results and the
[historical acceptance decisions](../../.agents/notes/archived/testing/2026-10-22-task-lifecycle-cross-layer-acceptance.md)
remain bound to their original source; they are not current module checks. CLI
native validation and independent Web browser fixtures retain their own scopes.

### Worker release protocol cutover

Stop old server instances and managing Workers and suspend release management
writes before running migrations. Start the new server after migration succeeds,
then run the matching CLI build. The migration lock does not prevent an old
server from writing released ownership again. A failed migration rolls back its
changes and checksum; do not start new business traffic until it succeeds. After
success, do not restore the old release writer. Existing Web readers accept a
missing worker, but an old CLI cannot validate the new release response. The
migration preserves task status, timing, ordinary materials and Session/archive
history while updating affected task versions and project cache epochs.

## Account in-progress Task reads

`GET /api/v1/me/in-progress-tasks` returns a lightweight, authenticated cross-project page of the caller's in-progress ordinary Tasks, with complete project counts, actual Parent Goal context and existing Session observations. The [API contract](../../docs/spec/daynight-personal-in-progress-tasks.md) defines ordering, cursor, revision, errors and partial observation semantics. The [server design](../../docs/design/daynight-server.md#账号进行中任务读取) describes snapshot and authorization checks and the cost of aggregating all Task history in active projects.
