# daynight-web

The React/TypeScript Web app provides a public product introduction and a private
workspace. The workspace implements project browsing, account-owned Worker
observations, cursor pagination, request cancellation, runtime API decoding, native
browser routing and a pure dependency graph model with horizontal and vertical layouts. Project task views
use an IndexedDB summary cache and the authenticated task-sync endpoint.
The project dashboard, task canvas and task detail dialog are embedded into the Go
server for single-origin delivery. The [localhost deployment](../../deployment/localhost/README.md)
starts the full UI/API/database stack; [dev-ci](../../deployment/dev-ci/README.md)
provides an isolated instance of the same production build.

The [requirements](../../docs/spec/daynight-web.md) own visible behavior and the
[architecture](../../docs/design/daynight-web.md) owns graph projection, request
lifecycles and delivery. The [task property requirements](../../docs/spec/daynight-task-properties.md)
and [design](../../docs/design/daynight-task-properties.md) own PR associations.
The [attachment requirements](../../docs/spec/daynight-task-attachments.md) and
[architecture](../../docs/design/daynight-task-attachments.md) own single-file
management, previews and their independent state; the
[attachment decision](../../.agents/notes/archived/feature/2026-10-21-task-attachment-web.md)
records their original choices. [Thread requirements](../../docs/spec/daynight-task-thread.md)
and the [Discussion design](../../docs/design/task-thread-web.md) own persistent
messages, replies, page memory and incremental continuity.

The [authentication requirements](../../docs/spec/daynight-auth.md) and
[architecture](../../docs/design/daynight-auth.md) define login, private
projects, member and invitation management, CLI device authorization, and personal access tokens. The
`AuthenticatedApp` implements their browser components and API client. Production
`Application` responds to browser location under the persistent `LocaleProvider`: `/`
shows the public introduction, `/setup` selects the zero-API guide, and other pages
use the existing authenticated lifecycle. `/login` is explicit and `/projects` is
the project index. Business APIs require a browser session or PAT; project
resources also require current membership, while Worker resources belong to the
current account and filter their saved task observations by current project access. The Go service
retains loopback-only listening. Trusted same-origin previews, relative resources
and keyboard behavior remain unchanged.
The [Web workspace decision](../../.agents/notes/implemented/feature/2026-10-22-web-auth-workspace.md)
owns the frontend lifecycle choices; the
[activation decision](../../.agents/notes/implemented/architecture/2026-10-22-authentication-activation.md)
owns production composition and credential-private acceptance.

## Public product entry

The public `/` page explains the shared work layer for developers, teams and their
coding agents. Its primary action opens a local interactive example; onboarding
continues through `/setup`. The introduction remains available when signed in.
A cancellable, read-only identity hint changes only the login/workspace navigation;
loading or failure does not block the public content or authorize private data.

`features/landing/` owns the page, bounded example data and interaction. Typed
English and Simplified Chinese messages cover copy, example documents, FAQ,
identity status and metadata; changing language preserves example selections.
Styles are scoped beneath `.landing-page`. The production page contains no
prototype controls or simulated account state. Default HTML share metadata and
locale-aware page metadata use the existing Vite-to-Go asset pipeline.

The [requirements](../../docs/spec/daynight-landing.md),
[design](../../docs/design/daynight-landing.md) and
[decision](../../.agents/notes/implemented/architecture/2026-10-26-public-product-entry.md)
own the complete visitor journey and public/private ownership.

## Daily setup guide

The header's book icon and visible Setup guide link appear before the language
selector and open public `/setup` in a new tab with native link behavior and
`noopener noreferrer`. The opener retains its current page. The expanded five steps explain CLI
installation with Node.js 22 or newer, `daynight login` device authorization,
discovering or creating a project from a Git repository's `origin`, `daynight skill install`
and registering and viewing the first task. Each step gives its execution
location, prerequisites, copyable text and success signal. Remote terminals can
use `daynight login --no-browser`; Agent reload instructions come from the
installer's actual output for the selected launcher and User/Project scope.

`SetupGuidePage` uses the typed `messages.setup` catalogs inside a public shell
with a localized title, breadcrumb, skip link and language selector. It displays
the current origin as information; the CLI's default login service remains
`https://daynight.cc`. Direct access, reloads, copying, locale changes and
focus/visibility restoration make zero API requests. No identity, provider, task
cache or business-resource lifecycle mounts. Return-to-project links load a new
document at `/projects`, where the normal authentication workflow starts.

Command blocks retain selectable source text, exact newlines and argument quotes.
One current copy operation disables the copy buttons until it settles. A floating
status message reports success or explicitly asks for manual selection when the
clipboard is unavailable or denied, without shifting content. Unmount and locale
changes invalidate old results; switching language does not repeat a copy.
The public reading layout supports the header at desktop, 390px and 320px widths.
Go serves direct GET/HEAD requests and reloads through the normal no-store HTML
handler; `/setup` and its descendants are reserved from authentication callbacks.
The [requirements](../../docs/spec/daynight-web.md#日常使用引导),
[design](../../docs/design/daynight-web.md#日常使用引导页) and
[decision](../../.agents/notes/implemented/architecture/2026-10-26-public-setup-guide.md)
own the behavior, mechanisms and trade-offs.

## Authenticated workspace

`AuthenticatedApp` runs under the persistent `LocaleProvider` and owns current-user
loading, the independent `/login` page, login continuation and session loss.
An absent `returnPath` defaults to `/projects`; supplied invalid targets produce
an explicit error. Anonymous protected links enter login with the actual task,
file and query destination. Existing sessions and completed authentication use
replacement navigation so history does not loop through login. Known callback
failures retain their validated destination. Invitation and device flows preserve
their secret/code context through login and account switching; ordinary logout
returns to the public homepage only after confirmed success. Failed logout stays
visible and retryable. Both
complete catalogs provide its `messages.auth` domain, including accessible names,
validation, notices and already displayed errors. Login, workspace, invitation, device authorization
and management dialogs expose the shared language selector; native formatters
render dates and counts. Language changes retain form inputs, dialog and
one-time secrets, identity and pending requests without restarting operations.
It composes the project list, graph, shared task-detail surfaces and My Workers
list/detail with private project creation, account/token pages, member/invitation management,
project execution-warning settings and explicit invitation acceptance.

`WorkspaceSidebar` provides peer My projects and My Workers entries in its
scrollable upper region. Accessible projects appear as indented links below My
projects. The project index selects My projects; project, member and settings
routes select the corresponding project. Both Worker routes select My Workers. Links preserve native
modified clicks, expose full names through accessible text and titles, and
truncate long visible names. Project children appear in expanded desktop and
mobile navigation and are hidden in the folded rail. Initial loading, empty and
failed reads have localized feedback and retry; Load more traverses subsequent
pages without removing earlier links on failure.

The existing `/account` entry and sidebar toggle stay in the footer. Desktop widths are
190px expanded and 68px collapsed. The footer stays reachable on long pages and
short viewports; icon entries retain accessible names, hover titles and selected
route styling. The topbar account link keeps its name and behavior.

`useSidebarPreference` saves only a JSON boolean under the origin-local
`daynight.web.sidebar.collapsed` key. A missing value expands the sidebar without
writing a default. Refresh, reopening, project navigation and account changes
retain the browser's appearance choice. Read, invalid-value and write failures
have localized visible feedback while the current in-memory choice remains
usable. Retry saves that choice, and only a successful write clears the issue.

At 740px and below, navigation uses a 60px rail and a 220px modal overlay. Its
open state is temporary and never overwrites the desktop choice. The overlay
contains keyboard focus, isolates the background and shares the reference-counted
body scroll lock with the graph and task detail. Escape and backdrop dismissal
restore the opener; route changes use the existing content focus behavior.
Route changes, the desktop breakpoint, identity verification, blocking recovery
and unmount close the overlay and release its own isolation and lock. Normal
identity verification continues to preserve the content's existing interaction
policy. Sidebar changes preserve the mounted project, cache, detail and graph
viewport without another request or synchronization loop. The
[sidebar preference decision](../../.agents/notes/implemented/feature/2026-10-25-sidebar-preference.md)
owns these state boundaries; the
[account navigation decision](../../.agents/notes/implemented/feature/2026-10-25-bottom-account-navigation.md)
owns bottom placement. Cross-tab live updates and server or cross-device
synchronization are outside the local persistence guarantee.

Task details expose the versioned automatic-execution permission: one bilingual
label and switch on the right of the status row below the title, with the
status/assignee group, platform and readiness on the left. Both enabling and
disabling require confirmation;
Cancel, close and Escape submit nothing. The switch keeps confirmed server
state until success and actual changes are disabled during `in_progress`.
Successful permission changes observed in the open detail show a floating status
bubble for three seconds without moving the heading, tabs or reading area.
Pending, refusal, unknown-result, reconciliation, read and freshness notices use
the shared floating notification layer. Permission and platform controls explain their lock reason
through hover and keyboard-focus tooltips. Dismissing a bubble changes only
presentation; reopening a detail with an already confirmed result does not replay it.
Standalone rows and graph nodes show each task's permission without turning a
root value into a chain aggregate. Full task and graph decoders require an
explicit boolean `allowAgents`; missing, null and nonboolean values fail.
Task/graph resources require nullable requiredPlatform (null/windows/linux/macos),
with no missing-key fallback. Rows and nodes retain read-only platform badges.
The detail combines platform display and editing in one select in the left
status group, with Any platform, Windows, Linux and macOS. Choosing the saved
value does nothing; a different selection opens confirmation showing the current
and target platforms. Only confirmation submits the captured exact version.
Cancel, close, backdrop dismissal and Escape preserve the saved value and restore
select focus. The select displays the last confirmed value until success; Any
platform clears the requirement with null. Overview has no separate platform
editor or Save action, and the control remains available on either detail tab.
In-progress tasks lock it. Platform confirmation shares status/permission
freshness, request ownership and unknown-result GET reconciliation. When space
permits, automatic execution aligns with the first status line. At narrow widths,
the left group and the complete automatic-execution control can wrap while
retaining full labels, right alignment and nonoverlapping controls.
`TaskDetailSessionProvider` owns detail, status, permission, platform and assignee
state within the authenticated branch, keyed by user identity/session generation.
All task mutations share one task write gate and exact-version freshness
checks. Pending or unknown results block other task writes;
conflicts require a fresh observation and unknown results require an actual task
read before another write. Close/reopen and navigation preserve the original
request owner, so late responses cannot change another task. Platform updates
preserve status, permission, assignee, dependencies, properties and execution times.
Same-user verification and project navigation retain it; identity replacement,
logout and anonymous state dispose it so old results cannot reach a new identity. Identity changes invalidate outstanding requests
and unmount user-owned content; a project 404 stays a resource error. Returning
from a hidden or unfocused top-level page checks `/me` in the background while
keeping the workspace visible and interactive. Pending verification preserves
focus, dialogs, drafts, scroll and embedded documents. Each new qualifying return
aborts and replaces pending verification, so earlier responses cannot overwrite
the latest identity decision. A failed check retains state behind the blocking
retry overlay until a successful check; the same user keeps their forms and view,
while a changed user remounts user-owned content. Previously loaded content stays
visible until identity loss, a different identity or a verification error is
confirmed. Leaving the top-level page pauses new API reads and writes before
any visibility-triggered refresh can dispatch. An authenticated mount that is
already away applies the pause before child request effects. Returning confirms
identity: same-user success resumes requests, while identity replacement or
session loss cancels queued requests from the previous session. Identity checks and logout bypass this wait.
The `/me` request alone uses browser HTTP revalidation with `cache: no-cache`.
Successful responses carry `private, no-cache` and a strong ETag over the complete
identity-bound representation. An unchanged authenticated response is bodyless
304 on the wire and reuses the browser's stored profile; reload still verifies the
current login without retransferring an unchanged avatar. A different account,
changed profile or missing HTTP cache receives 200. Authentication and profile
read failures retain no-store errors; no custom `/me` IndexedDB is used.
A failed check keeps requests waiting through recovery. The [foreground verification decision](../../.agents/notes/implemented/bug-fix/2026-10-23-silent-foreground-identity-checks.md)
records this presentation policy. Ordinary same-origin
iframe focus changes do not count as top-level returns. Requests
use same-origin browser credentials and preserve request IDs, cancellation and
explicit failures. Member and project-settings versions remain `bigint` from
JSON decoding through mutation encoding, including values above the safe
JavaScript integer range.

PAT values and invitation links are displayed only after creation. Copy failure
keeps a recoverable action; closing the secret dialog requires confirmation. The
invitation entry removes its fragment immediately, uses tab-local temporary
storage across login, and clears it when the workflow ends. Inspection does not
accept an invitation. The UI retains ordinary same-origin attachment iframes,
relative resources and their existing keyboard bridge.

The login page reads `GET /api/v1/auth/providers` with response
`{providers: [providerId, ...]}`. The production backend uses public UniAuth SDK
`v0.0.0-20261022095215-0978963813fc` to discover the configured App's allowed and
enabled providers with its registered callback. This result is authoritative;
the UI does not invent a provider list. Configuration failures return 503,
network/protocol failures 502 and discovery timeout 504, separately from a
user-session 401. Discovery failures and an empty provider set have explicit
states. The [authentication architecture](../../docs/design/daynight-auth.md#登录方式发现)
owns the discovery protocol.

The `/device` entry retains its optional `user_code` through browser sign-in and
shows the current account, authorization code, project permissions, and how to
manage access. CLI access does not expire automatically. Opening the page reads
the request without granting access. The
user must compare the displayed terminal code, select its confirmation checkbox,
and explicitly approve; denial requires no matching-code confirmation. Both
operations send the reviewed account ID so the server can refuse a changed
browser principal before altering the grant. API responses also validate the
admitted identity against the displayed account. An uncertain decision blocks
further decisions until inspection confirms the actual state. Inspection never
replays approval, and a still-pending result requires another explicit decision.
Identity changes abort requests and remount this page through the shared shell.
CLI access appears in the account token list, where its expiration can be changed
or access revoked. The device request's ten-minute approval deadline remains
independent of the token lifetime.

Token creation defaults to Never expires and optionally accepts a future local
date and time, serialized as a UTC `expiresAt`. Token metadata requires either a
UTC timestamp or explicit null; null is displayed as Never expires. The shared
expiration editor also changes active tokens without changing their secret or
requiring clients to sign in again. An unchanged editor preserves the original
timestamp, including seconds and fractional precision, and does not submit.
Updates send the exact observed `expectedExpiresAt` and displayed account ID.
Token list and update responses must identify the reviewed account before their
metadata can be rendered. A conflict refreshes the current expiration for review.
An unconfirmed update blocks further writes until a token-list read confirms
the actual state; a failed read retains the displayed metadata and the write
block. Reads never repeat the update. Expired, revoked, and missing tokens are
unavailable for editing.

## My Workers

The account-owned `/workers` list and `/workers/{workerId}` detail show Workers
that have reported within the last 72 hours. Both support direct access, reloads
and login return destinations. They mount inside the existing authenticated
workspace and share its navigation, styles and language. Sidebar project loading
or failure does not admit or block Worker reads. Worker ID participates in the
page's resource key, content focus and mobile navigation lifetime.

The list uses only the actual summary: machine name, platform, last report time,
task observation state and currently visible task count. It does not infer an OS
release or load every detail. `null` task count means information unavailable;
observed zero means idle. Stale task information retains its observation time.
The complete collection sorts online first, latest report next and Worker ID as
the stable tie-breaker.

Detail resource cards render actual OS type/release/version/architecture, CPU
model/logical processor count/use, used/total memory and available/total capacity
of the startup working directory's filesystem. Capacity readings use localized
IEC units while the API retains exact byte values. The directory is explicit; there
is no inferred physical core count or fabricated device label. Zero capacity is
valid data and does not produce a division-based meter. Software rows distinguish
an installed version, unavailable detection, Codex/Copilot not installed and
private Herdr not running. `checkedAt`, `sampledAt` and server `lastReportedAt`
retain their different meanings. Version text is displayed without adding a
minimum-version or semantic-version check.

`api/workers.ts` decodes the account snapshot contract and admits the principal
before parsing either a successful response or a resource error, including 404.
`useWorkers`, `useWorker` and `useWorkerObservation` retain only page-local memory.
They reuse TaskCacheScope for authenticated lifetime and foreground admission;
Worker data never enters the project cache, IndexedDB or a global registry.
Reads and publication both wait for identity confirmation, and abort signals,
resource identity and request generations fence late results. The shell's
`readEnabled` pauses private work during identity checking and blocking recovery.
Same-account verification retains the last observation but rereads it; account
replacement destroys the old workspace and its memory.

One visible page owns one five-second single-flight refresh and one one-second
ticker. The list traverses every cursor privately and replaces the collection
only when the whole traversal succeeds. A failed page retains the previous
complete collection and exposes retry. Its last response supplies `observedAt`
and the paired `performance.now()` receipt for a common server-time anchor.
Online means less than 120 seconds since `lastReportedAt`; exactly 120 seconds
is offline. Exactly 72 hours remains recent; later observations disappear, and
an expired detail becomes unavailable. Browser wall-clock changes do not affect
these rules.

Read failure, hidden state and identity checking freeze the last published
server time and mark retained content stale. Visibility return or same-account
recovery starts a fresh read; only success recalibrates the anchor and resumes
the ticker. Normal checks retain the displayed resources, source times, focus
and last-confirmed labels without inserting a warning or moving the content.
Badges reserve the intrinsic size of their localized last-confirmed label so
the longer text does not rewrap adjacent report details on narrow screens.
Task headings retain their title and snapshot-caption footprint; the current
observation hides that caption visually and from its accessible name.
Actual refresh failures show the synchronization error, last successful
observation and retry action throughout further attempts until success. Worker
offline notices and probe failures retain their distinct meanings; browser
connectivity does not establish Worker liveness. An admitted current-principal
404 clears the old detail. Initial loading, initial failure, empty results and
retained-snapshot refresh failure have separate displays.

Online badges use green. Offline text and dot use `#b54708` on `#fff0e6`, with
explicit labels in the list, detail and narrow layout. Historical task rows and
counts use only the server's currently authorized snapshot. They show simple
business status, existing phase and agent, including Claude Code, while real
anchors open the current task through `taskDetailUrl` and preserve modified and
new-tab clicks. A project cache cannot restore a title, row or count removed by
the server. Neither offline state, expiry nor a read error mutates a task or
claim. Stable React identities preserve still-present keyboard targets during
ticks and refreshes; desktop and 390px layouts wrap long names, paths and tasks.

The [Web requirements](../../docs/spec/daynight-web.md#我的-worker),
[Web design](../../docs/design/daynight-web.md#我的-worker-列表与详情) and
[observation decision](../../.agents/notes/implemented/architecture/2026-10-29-web-worker-observations.md)
own the page behavior and its rationale. The
[snapshot protocol](../../docs/spec/daynight-worker-snapshots.md) owns the exact
DTOs and permission filtering; the
[client reporting contract](../../docs/spec/daynight-worker-reporting.md) owns
collection, reporting and version age. Component or controlled-browser results
prove their stated frontend scope; combined Server, CLI and Web acceptance must
separately establish real reporting, resources, permissions and recovery.

## Project execution-warning settings

`/projects/{projectId}/settings` is a sibling of the members page, linked from
the project and shared project-management navigation. Direct GET/HEAD entry and
reload use the embedded application. Every member can read the saved threshold;
only an explicitly resolved administrator can edit and submit it. The form uses
integer minutes from 1 through 2147483647, initially 60, with save, cancel,
pending, validation and localized error/recovery states that remain usable on
narrow screens. Graph cards and standalone rows consume the saved value through
the shared execution-time presentation described below.

`ProjectSettingsPanel` is keyed by user/project and delegates saved Project,
draft, role and operation state to `useProjectSettings`. It loads Project and
membership together, retains the exact observed settings version and submits
`PATCH /api/v1/projects/{projectId}/settings`. A successful response is the full
Project; a current equal-value save preserves version and updatedAt, while a
real update advances both. A draft or confirmed refusal never becomes the saved
value. Conflict or permission refusal rereads Project and membership without
replaying PATCH; missing access clears private Project data and the draft.

Network, protocol or 5xx failure after PATCH leaves the write unconfirmed. The
form reconciles Project and membership before enabling another mutation. Failed
reconciliation leaves Save blocked and exposes a read retry. Navigation aborts
obsolete client work without claiming that a committed write was rolled back;
returning to the page loads authoritative state before editing. The existing
foreground identity guard preserves same-user drafts and focus, while identity
or project replacement invalidates old requests and results.

Project resources include required `settings.version`,
`settings.executionWarningMinutes` and `ownership:{teamId,version}`. The resource
codecs share validated raw JSON source-field maps and convert only declared
Project settings, ownership and grant version paths. Unknown nested-field
semantics remain intact; no browser reviver source-context feature is required.
Versions above 2^53 remain exact bigint values and mutation encoding sends JSON
numbers. Missing contract fields do not acquire defaults.

Project synchronization merges intrinsic summaries by ID and exact business
version in the current durable collection, then derives task readiness,
statistics and GraphIndex. Duplicate summaries retain task and index references;
settings and ownership merge independently by their exact versions within one
epoch. Equal ownership versions must identify the same Team; contradictions fail
synchronization. Metadata-only changes preserve task projection. A new epoch
snapshot fully replaces Project, including legitimately lower restored versions,
while old-history ownership cannot carry forward. Clock-only responses retain the graph and index while refreshing the separate
latest `GraphSnapshot.observedAt` and its paired `receivedMonotonic`. No settings
edit changes task time or graph geometry.

## Persistent task summaries

`TaskCacheProvider` wraps every authenticated route outside the shared detail
session. Its scope follows the user and session generation, including standalone
task and attachment routes. The origin-local `daynight-task-cache` database uses
schema 6 and idb 8.0.4, with `userScopes`, `projects`, `summaries`, `details` and
`profiles` stores. Upgrading the ownership-complete schema 5 adds profiles while
preserving compatible task records, user fences and watermarks. Upgrades from
schema 1, 2, 3 or 4 rebuild incompatible projects, summaries and details, rotate
user fences and clear old epochs/watermarks before a complete snapshot. Missing
properties, assignedTo or Project ownership in old records cannot receive
defaults.
Upgrade failures roll back, and old connections close on versionchange. User fences, project generations and validated manifests guard late
responses and cross-tab transactions. `lifecycle.ts` checks ownership, canonical
fences/generations and bounded counts for both active and invalidated manifests.
An invalidated manifest has a recognized reason, null epoch/Project/watermark and
zero task/edge counts; it cannot retain a usable incremental baseline. The shared
details store and guarded transaction interface support intrinsic content reuse,
bounded LRU and business-version-driven detail reads.

`beginSync` reads the epoch and greatest exact accepted summary `updatedAt`;
`applySync` validates the transaction's complete durable set and atomically saves
changed summaries with that watermark. Every snapshot/delta record contains its
required nullable assignedTo and complete current properties from the task row's
database snapshot. Higher task
versions replace whole summaries and property maps; missing keys remove old
values without property tombstones or ordinary epoch changes. Equal-version
content must match all intrinsic fields, including assignedTo, and all own
property keys and JSON values: object order is
irrelevant, array order matters, and missing differs from null or an empty array.
Older responses cannot revive removed properties. Graph projections explicitly
drop properties while retaining assignedTo; the summary map keeps complete properties. Only project-sync summaries
advance the watermark.
Details, mutations, request time, Project time and `observedAt` cannot establish
project coverage. UTC seconds plus nine fractional digits preserve ordering;
business versions remain bigint. The default ten-second server overlap can
repeat its final rows indefinitely, and old/equal rows do not rewrite storage,
invalidate detail records, replace published indexes or broadcast. Network,
HTTP, decoding, quota and IDB-completion errors preserve the prior valid cache
and watermark without partial publication. Invalid stored properties fail the
complete sync request with 400 invalid_input; database and transaction-completion
faults remain 500 internal_error. Complete properties increase transport, parsing,
full-set validation and summary storage costs. Graph node/edge limits and the
detail LRU byte budget do not bound total summary bytes, and arbitrary legal
maximum payloads are not guaranteed to fit every browser quota.

After identity verification, a project publishes its validated local summary
snapshot while task-sync runs in the background. Valid empty snapshots render
normally; missing or invalid baselines retain loading until synchronization.
Recoverable sync failures retain visible summaries and expose Retry. Summary
publication does not authorize detail bodies or task writes: those still require
this mount's successful online project sync. A local-only detail mount keeps its
visibility gate local and leaves shared session observation unchanged, so an
already accepted operation can finish preparation in its original authorized
history; this mount's first live receipt still requires its own opening GET. `Daynight-User-ID` is checked before decoding or acting on sync, detail and task
mutation responses. A verified different principal synchronously releases old content
and starts identity verification. Headerless or malformed-principal errors retain
valid cached content. Project-sync not_found, a trusted not_found for a task known
when GET started, or a trusted task-write not_found immediately withdraw matching
project admission. Unknown task IDs remain local errors. Captured ticket checks
prevent an old-generation response from clearing a replacement generation. Scope invalidation aborts current work and releases memory before its
user-specific persistent purge; ordinary disposal closes resources and preserves
the durable base. Foreground gating covers durable reads and positive publication;
negative access events hide content immediately while persistence waits for the
gate. `canRevokeProject` and `revokeProject` check the captured user fence/generation,
retire local reuse synchronously, and purge only the matching durable generation
through the existing transaction. Scope-owned cleanup outlives the view; failure
keeps admission denied, and beginSync retries cleanup before a fresh online sync.
An old graph receipt alone cannot re-admit the detail. `canPreviewProject` also
keeps local summaries hidden after effective withdrawal, deriving eligibility
from existing retired generations and online authorization. The hook checks it
both before and after the asynchronous disk read. Same-scope navigation, remounts,
ordinary hints and failed Retry or polling cannot restore previews, even when
CAS cleanup preserves a newer durable generation. Successful online sync restores
authorization without removing the old-generation fences.

Ordinary broadcast hints contain no task content or access grant; authorized
receivers reread committed stores without another network request. Negative hints
carry userFence/revokedGeneration and immediately deny matching peers, including
a bound cold peer with no projection, without rebroadcast. Stale hints cannot
replace a newer generation or denial. Failed IDB opening,
blocked upgrades, abnormal close, corruption or writes use existing visible
error/Retry states and retain an allowed current view. Missing or malformed user
scope records are repaired in one shared-cache transaction: replace the fence,
clear only that user's summaries/details/profiles and invalidate its project baselines.
The repair never parses or reuses the damaged fence. For that user-corruption
repair, memory binding, scope retirement and hints wait for commit; a cold scope can then bind the replacement,
while an already-bound scope retires and requests identity verification. A failed
repair rolls back without retiring the detecting scope, exposing a retryable
storage error. Other users remain intact, and stale tickets fail against the new
fence before publication. There is no silent network-only fallback. `Task sync` diagnostics report cycle/project IDs,
received/changed/duplicate counts, cache hit and apply duration; duplicate includes
ignored old versions. Failure diagnostics expose categories and a depth-limited allowlist of cause
names/codes, without raw messages, stacks, task bodies or credentials. The [cache architecture](../../docs/design/daynight-task-sync.md)
owns the algorithm, schema, failure rules and detail integration.

## Persistent task details

`TaskDetailSessions(scope)` uses the same authenticated scope and schema-6 details
store as project summaries. `detail-cache.ts` validates intrinsic bodies against
the current summary and guarded lifecycle ticket, then materializes readiness and
blockers from the complete local graph. Full current properties preserve actual
present keys: an absent worker means no retained ownership, while a present
worker is an object whose nullable inner fields retain their defined meaning.
Detail-to-summary consistency includes assignedTo and uses the same complete
semantic property comparison. A new summary version invalidates its
detail; prerequisite-only changes update derived fields without successor GETs.
Raw server-derived disagreements are retained separately before materialization,
so stale feedback and write restrictions cannot disappear through local overwrite.
Every admitted opening calls `requireOpeningRead` before operation blocking is
considered, recording an in-memory opening generation that its live GET must
satisfy. Pending/unknown operations delay the GET without losing that demand;
disk, mutation results, same-version no-ops/refusals and reconciliation begun
before reopening cannot grant later-opening authority. Duplicate polling receipts
do not create openings. Project-generation changes immediately clear the old body,
PR data and loadedRevision, cancel old reads/pending bodies and reset freshness
and committed-version floors. Render-time generation checks suppress old content
before effects, even when the replacement GET hangs or fails. Operation intent
and confirmed/unknown phases survive, while canceled reconciliation becomes
retryable; only same-generation refresh failures retain the successful body. During foreground auth pauses, rendering getters retain only
previously observed memory values; requests, transactions and new-mount admission
still wait for identity verification.

`readCachedDetail` touches lastUsedAt on a real cache read. `saveDetail` skips
identical persistent content and returns matching/older/newer admission. The
session holds newer GETs for project synchronization before installation. A
validated confirmed write can show its newer raw body after guarded lifecycle
checks, with mismatch/fresh-read restrictions, until summaries catch up; it is
not persisted ahead of the summary. The feed exposes current rows and can skip
intermediate business versions. A pending body above the summary keeps waiting;
an exact match is admitted under its captured ticket. When the summary overtakes
it, the session discards that body and queues the required GET with its original
purpose through the existing queue, retaining operation intent, outcome and
version floors. Ordinary reads fail visibly through detail error/Retry and clear
their own blocker on successful GET. Mutation readback retains reconciliation
purpose and keeps Check state/Retry usable on failure; ordinary recovery cannot
leave a hidden reconciliation blocker. Duplicate receipts do not loop mutation
readback, and explicit Retry only reads. Neither operation writes summaries
or their watermark. Limits are 32 records per project, 8 MiB total and 2 MiB per
record, using UTF-8 bytes from exact intrinsic JSON; LRU uses lastUsedAt with task
ID as a tie-breaker. Oversized successful bodies stay readable in the active
session without persistence. Corrupt detail rows or aggregate budgets clear only
the project's details under the captured lifecycle, then expose the original
error; Retry reads actual storage and performs live GET. Cleanup/write failures
remain visible rather than enabling a silent network-only path.

Detail GET and all task mutations require explicit `TaskResponseAdmission`
with userId and onPrincipalMismatch. Same-user HTTP 200 confirms the remote write
response before payload parsing, separately from whether a body can be installed
or cached. Malformed bodies require GET-only reconciliation; cache failures keep
the confirmed operation and an error without replaying a write. Existing pending,
unknown, reconciling and exact-version gates remain. The
[cache architecture](../../docs/design/daynight-task-sync.md#6-投影时钟与详情)
owns the complete admission, race, budget and failure rules.

## Task assignees

Task, summary and graph consumers require an explicit assignedTo field containing
null or a canonical local user UUID. Equality, freshness, review keys and material
preservation include the field. Its native storage, atomic permission reset and
in-progress write policy belong to the [assignment contract](../../docs/spec/daynight-task-assignment.md).
Schema 6 preserves strict task parsing and stores versioned profile content in a
separate store; profile data never enters task records or task versions.

The detail places status and assignee in one 24px compact group, followed by
platform and readiness, with automatic execution on the right. The assignee
control shows the confirmed value with a 16px avatar; rows use 17px avatars.
Names and avatars retain actual nullable values. Missing profile data or a null
name displays a short UUID, failed images use an identity placeholder, and only
an explicit hasProjectAccess=false result marks a former member. Long names
retain accessible full text and narrow layouts keep controls within the viewport.

The shared picker uses the complete qualified-person manifest from task-sync and
loads only missing or changed profiles. Ordinary reopening reuses matching
content and in-flight work; explicit Retry recovers failed or missing items.
Search accepts names and UUIDs; assignment choices contain current members and
clearing, while filters can retain former assignees. Loading and failure keep
choices unavailable with explicit recovery. Arrow keys move among
options, Escape closes and restores the trigger, and Tab or outside click closes
without stealing subsequent focus. A fixed popup stays inside the surface's
focus-owner subtree and tracks scrolling, resizing and fullscreen changes.

Choosing the saved assignee closes with no write. A change sends one ordinary
Task PATCH with the captured exact version and UUID or null. TaskDetailSessions
checks the expected +0/+1 version, assignment, permission and preserved materials;
all other operations retain assignment. A successful response installs the full
Task. Conflicts read current state, and unknown outcomes use GET-only
reconciliation without replaying PATCH. Pending, stale, in-progress and unknown
states share the existing write gate. Added controls and results express rules
through values and availability, retaining necessary errors, access status and
recovery actions.

TaskAssigneesProvider lives inside the authenticated TaskCacheProvider and outside
the detail provider. Every successful task-sync supplies required complete
`assigneeVersions` metadata: `{userId, version, hasProjectAccess}` for each current
member or retained assignee, including when tasks are unchanged. Versions are
server-issued lowercase SHA-256 content identifiers for user ID, nullable name
and avatar only. Access, role, login timestamps and task changes do not alter an
unchanged profile's version.

The `profiles` store persists `{userId, version, name, avatarUrl}` under the
viewer/project/profile-user key and userFence. It stores no access boolean.
After live `/me` and project admission, the owner hydrates content matching the
fresh manifest. Local summary previews supply no people qualification. Mounted
row, detail and selected-filter demands are coalesced; only qualified people with
missing or changed content are resolved in batches of at most 100. Nullable
fields remain complete data. Empty demand sends no request. Ordinary task opens,
successful empty deltas and picker reopening reuse matching profiles, including
their inline data-URL avatars. Access-only changes use the live manifest without
redownloading the same content.

In-flight demands are shared. Same-history results remain useful after demand
changes, and each GET retains its actual observed content version. A profile
read newer than its initiating manifest cannot be relabeled with the old version
or cause an immediate retry loop. Ahead-of-manifest and transient unresolved
exceptions last only through their current positive graph-receipt observation.
The next new successful receipt clears them even if content tokens are unchanged;
duplicate receipts and presentation changes preserve the observation. Each GET
captures that observation, so an older conflicting result cannot restore its
exception later. Normally matching cached profiles still cause no extra GET.
Generation or userFence replacement immediately withdraws the old people,
qualification, access markers and ready catalogue. A cross-tab replacement with
`assigneeVersions: null` follows the same rule: a requested catalogue waits in
loading, an unopened one stays idle, and unknown metadata is not a successful
empty catalogue. Ordinary task epoch replacement retains only raw same-userFence
content until a fresh online manifest validates it; userFence replacement clears
old content. All reads, writes and publication check the current generation. Logout, account change,
session loss and project access withdrawal clear the corresponding profiles.
Failures stay visible and retryable. Trusted same-user project 404 responses
withdraw admission even after presentation changes; stale histories cannot
withdraw a replacement generation. The [request-reuse decision](../../.agents/notes/implemented/bug-fix/2026-11-04-task-view-request-reuse.md)
owns the versioning, HTTP cache and scan-cost trade-offs.

The task-list filter supports All, Assigned to me, Unassigned and a person. It
intersects recent/show-all selections before pagination and returns to page one
when changed. Standalone rows match directly. A chain with any matching member
retains its real representative as context and shows matching children and count;
full-chain progress, readiness, dependencies, statistics and graph use the complete
index. Overview positioning can clear a filter that hides its target. The
[assignment design](../../docs/design/daynight-task-assignment.md) owns the people,
mutation and presentation mechanisms.

## Steps reading

Task details always expose Steps after Overview, in both the dialog and standalone
page. `tab=steps` preserves the tab through direct access, reload and browser
history, including details without a Session. Reading shows the ordered title,
four-state status and task-local ID; multiple expanded rows render Task-root
Markdown and timestamps through the same attachment controller as Overview.

`TaskDetailSessions` owns a separate lazy Steps resource in memory. Summary,
parent-detail and confirmed mutation versions invalidate it; identity, cache
generation and version admission fence late responses. An ahead resource waits
for summary admission and requests parent/project refresh, while stale responses
are reread against the highest verified floor, including pending parent details.
Refresh and reader release retain that scalar floor within the same cache
generation. Confirmed parent deletion fences in-flight reads and asynchronous
admission so late responses cannot restore a deleted detail. First-read errors, valid emptiness and
retained-content errors remain distinct and retryable. A Steps 404 checks the
parent before retiring access; 403 remains a refusal, and parent 410 uses the
existing deleted-task presentation. Retirement and the last active reader's
unsubscribe release complete collections, including pending admission. Steps never
enter the TaskDetail LRU or IndexedDB.

The list mounts at most 100 rows per page, with global numbering, previous/next
buttons and a numeric page input. Paging makes no API requests; expansion remains
bound to IDs across pages, same-task tabs and refresh reordering. Both languages
and the 320px layout retain reading and recovery controls. Web writing controls
are not exposed. At heights up to 500px, a single scrollable tab row reserves
reading space; the tab owner reveals its target after focus, selection styling
and locale updates. At heights up to 600px, pagination scrolls with the list so
its controls cannot cover the remaining reading area. The [resource requirements](../../docs/spec/daynight-task-steps.md#web-阅读)
and [design](../../docs/design/daynight-task-steps.md#web-资源与单一写入所有者)
own the complete read lifecycle and the remaining write architecture.

## Session display

Task, Test and readable archived Sessions share the Display menu beside Refresh.
Conversation is the default and keeps messages, plans, interactions and real
errors; Standard preserves the complete activity view. The authenticated account
and verified Session ID select a shared page preference, persisted independently
from drafts and execution identity. Storage failures retain the current choice
and expose retry only inside the menu. Both modes and all menu text follow the
page language. Changing mode preserves the client, channel, Composer, retained
entries and reading intent without replaying operations or altering pagination.
The [requirements](../../docs/spec/task-sessions.md#session-显示模式) own the
display rules; the [Session design](../../docs/design/task-session-protocol.md#session-显示菜单与入口绑定)
owns identity binding, menu behavior and preference integration.

## Task discussions

Task details always provide Overview, Steps, Attachments and Discussion tabs, followed
by Session when native execution content is available. Discussion works before
execution starts, after completion and while an execution environment is offline.
It reads and posts directly to the task Thread resource; ordinary browser posts
use the current authenticated account without a claimId and do not change Task
status, version, properties, dependencies, task-sync or worker control.

Each open task owns a controller scoped by user, project and task. Messages,
drafts, references and the continuously consumed message ID stay in bounded page
memory, without IndexedDB, TaskCache, BroadcastChannel or browser persistence.
Same-task tab changes retain them; closing or leaving the task and confirmed
access loss clear them. The authenticated shell supplies its existing account
context, and the controller reuses account admission and revocation signals.
It does not request another current-user or member list for message authors.

An active, visible Discussion reads new messages every five seconds after a
successful read and immediately catches up complete pages. Hidden tabs and pages
pause reads. History, references and post receipts never advance the independent
consumed-after ID. Visible and incoming count/byte caps retain complete bodies;
explicit navigation can replace displayed history, which remains reachable by
before/after ID paging. Only a reading anchor, the latest confirmed receipt and
one pending POST reservation can be fixed, so repeated own posts cannot prevent
older unseen messages from progressing. The new-message count describes retained
incoming messages rather than the service's total backlog.

All Web reads request details=true. Author names and Agent provider badges use
immutable message snapshots; missing or blank names use a separate full account
ID label, and current worker settings never rewrite history. Safe Markdown keeps
line breaks and local code/table scrolling without raw HTML or remote image
loads. Reply previews use a known parent directly; an out-of-window parent loads
only on demand with at most two bounded list reads and an exact target check.
Message details use a nested native dialog that owns Escape/Tab and restores
focus within page, modal and fullscreen task details.

The composer preserves original whitespace and code indentation. Ctrl/Command+
Enter sends outside IME composition. A valid 201 confirms the remote message and
ends its response timer before same-account authentication re-admission; later
local failure cannot turn that confirmation into an unknown result. Only the
submitted draft/reply revisions clear on success. Explicit refusals and unknown
outcomes preserve draft content, and refresh never repeats a POST. Equal body
text is not a submission identity. Validated parent access errors clear the
scope; a missing reply or pagination message is a local error that retains data.

The [design](../../docs/design/task-thread-web.md) and
[decision](../../.agents/notes/implemented/architecture/2026-11-03-task-thread-web.md)
own the full decoder, capacity, lifecycle, keyboard and verification rules.

## Task execution time and possible stalls

A local-only snapshot has revision zero and no server clock or successful receipt.
It displays neither a refreshed timestamp nor running durations or stall warnings;
completed durations still use their persisted endpoints. Overview uses client wall
time for provisional recent-completion classification, then switches to the live
server sample. This provisional time never establishes execution time or sync
coverage.

`useTaskGraph` captures `receivedMonotonic` immediately after decoding task-sync,
before IDB application or index work, and pairs it with that response's database
`observedAt`. `receivedAt` remains the local-wall-clock refreshed label. A stable
`TaskExecutionClockProvider` per loaded project advances the server sample with
`performance.now()` elapsed time and publishes saved threshold changes in the
same layout effect. Its estimate includes post-receipt render/commit delay but
does not compensate for network or parsing delay before that receipt; client
`Date.now()` does not determine duration or warnings.

Only mounted running tasks with a known start subscribe to one visible-page
one-second ticker. Completed tasks subscribe only to threshold metadata and use
their persisted endpoint difference; unknown timing has no active subscription.
Hiding pauses ticks, visibility return publishes monotonic elapsed immediately,
and ordinary guarded polling separately reanchors time. The last running
unsubscribe and provider unmount release timer/listener work. There is no new
blur listener, per-card request or server worker. Clock samples and settings stay
outside graph-index, projection and layout dependencies.

Task cards, standalone rows and Goal child rows show live elapsed or frozen
completed duration. Todo tasks and incomplete intervals show no inferred duration.
On cards and standalone rows, running tasks with `allowAgents=true` use an exact
millisecond comparison strictly above saved minutes to add amber treatment,
icon and Possibly stuck / 可能卡住了 while retaining the running status. Tasks
with `allowAgents=false` retain live duration without warning text, styling or
accessible warning meaning; completion removes any warning. Localized
text distinguishes less than one minute and uses floored day/hour/minute units
without changing comparison. On cards and standalone rows, semantic `time`,
its title and `aria-describedby` provide exact endpoints, elapsed duration and
saved threshold. Button names stay
stable across ticks, and no live region announces every update.

The renderer preserves 220×96/136 cards, independent Details/inspection/expansion
controls, external context borders and selected/prerequisite
outlines. A 42px bottom reserve keeps English Details clear of elapsed text.
Standalone visual timing is excluded from button-name calculation while its
accessible description retains the warning meaning. Goal child rows reuse
`useTaskExecution` and `TaskExecutionDuration` after their title, with a clock icon
and muted localized text. The duration-only tooltip omits threshold and warning
meaning; those remain owned by cards and standalone rows. The timing subtree is
excluded from the child button name, so ticks preserve its accessible name and
focus. Inline titles and full duration text wrap within the available width,
including multi-day values on narrow screens. Rows share the existing project
clock without per-row timers or requests. Chain headers never claim an individual
task's duration as aggregate execution time.

While membership loads, the project heading reserves complete action geometry,
including localized links and the wider administrator badge. Its inaccessible
placeholder is replaced by authorized actions without narrowing the title or
moving the restored page position. The
[header-layout decision](../../.agents/notes/implemented/bug-fix/2026-10-23-project-header-layout-shift.md)
owns that geometry; the existing
[shared-scroll decision](../../.agents/notes/implemented/bug-fix/2026-11-03-shared-task-list-scroll.md)
owns one task-list page offset per project, independently from Overview and graph viewports.

## Languages

The [language requirements](../../docs/spec/daynight-web-i18n.md) define the
implemented English and Simplified Chinese interface. The
[language design](../../docs/design/daynight-web-i18n.md) owns typed catalogs,
cached native Intl formatters, initial resolution, a Provider and the shared
native selector under `src/i18n/`. Production `main.tsx` resolves language and
sets HTML `lang` and the route-appropriate introduction, guide or authentication
loading title before React renders.
The public page, guide and `AuthenticatedApp` update their document metadata on
navigation and language changes; the public introduction also updates description
and share copy. The top bar and graph-dialog header
expose selectors in both dialog modes using the same saved language. Task details consume the current
application locale through the same Provider; their header contains the task
title with an adjacent copy icon, fullscreen toggle, More task actions menu and
close control. Status and assignee share the state-row control group before platform selection. The `…` menu sits immediately left of Close and contains Open in new tab
and Delete task; the standalone page retains only Delete task in that menu.

`LocaleProvider` requires an explicit initial locale result. `useI18n()` reads
`locale`, `messages` and `format`; `useLocaleCommands()` exposes selection and
save retry; `useLocalePreference()` additionally exposes the current storage
issue. Hooks fail clearly outside the Provider. Component tests can use
`tests/helpers/renderWithLocale.tsx` to choose deterministic language and storage
behavior. `common.status` and `common.requestId` own shared task labels;
`workspace`, `graph` and `inspection` own navigation/project, graph and
detail/PR/attachment messages in both complete catalogs. Structured errors and
semantic notices render in the current language, including operations completed
after switching. User content, request IDs and exact file bytes keep their values.

Initial resolution prefers a valid explicit value, then the first supported
browser language, then English. Chinese language variants use Simplified Chinese.
Automatic detection does not save a choice. Explicit selection saves raw `en` or
`zh-CN` under the origin-local `daynight.web.locale` key, independently of all
per-project browsing records. Read, invalid-value and write failures remain
visible in localized selector text; a successful save clears the current issue,
including startup errors. Cross-tab live synchronization and account preferences
are outside this runtime's persistence guarantee.

Production claims require real service receipts. Web typecheck, test and build
include all translated components under the existing coverage gate.

## Development

Use Node.js 24 LTS and pnpm 11.28.6. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm web:dev
```

Run the Go API separately on `127.0.0.1:8787`, using its
[configuration](../daynight-server/README.md). Native macOS development uses an
ordinary writable storage directory and does not require an APFS image. Names
that alias another file or directory on that filesystem are refused; Linux CI
owns case-coexistence coverage. Vite proxies `/api` to that address
and listens on loopback. For real login through Vite, set the same
`DAYNIGHT_UNIAUTH_CALLBACK_URL` in the Vite and Go environments, registered with
UniAuth for the development browser origin. Vite proxies exactly that callback
path through the same Go API target. When unset, no callback proxy is added. The five required
backend authentication settings and explicit HTTP test policy follow the
[deployment guide](../../deployment/localhost/README.md); changing the browser
origin does not relax callback or Cookie-write Origin checks.

An identity-scoped projects provider supplies both the sidebar directory and
project cards from one request owner. It requests 50 items per page, preserves
server order, and follows `nextCursor` through Load more. Repeated IDs count once.
Project navigation retains loaded pages. Refresh discards old pages and cursors;
late responses cannot repopulate them. Direct-grant controls remain available
for the final direct administrator; inherited-only participants have no editable
grant version. After confirmed self-removal, the panel revalidates current access
and navigates away only after authoritative withdrawal. Inherited access retains
the Project page; network, protocol or server failures keep a visible read retry
and never repeat the write. Creating a project or confirmed loss of one's own
access refreshes the shared directory; a new authenticated identity starts
with a new directory. The [project navigation decision](../../.agents/notes/implemented/feature/2026-10-27-sidebar-project-navigation.md)
records ownership and pagination choices.

The application implements public `/`, explicit `/login`, the `/projects` index,
`/projects/{projectId}`, `/account`,
`/invitations` and the standalone
`/projects/{projectId}/tasks/{taskId}/attachments/{path...}` reader, direct URL
reload, browser back/forward and a generic not-found page. All resource reads use
the current authenticated identity. A project without a saved section preference
opens Overview, with six statistics and an overall progress list from the complete
snapshot. Its recent rows include every unfinished ordinary task-chain component
and completed components from the latest seven local calendar days. A row shows
the representative title, completed/total count and a floored integer percentage.
A Goal completes only when all ordinary members are done; its last member
completion determines recency, with external prerequisites excluded. The latest
known member completion supplies evidence when some historical times are unknown;
without known recent evidence, completed Goals appear only through Show all.
The standalone aggregate row combines every unfinished standalone task with known
completions in the same window. It remains visible at 100% when only recent
completions remain, as do recent completed Goals. Project statistic cards retain
full-history totals.

The window includes today and the previous six days in the browser's local time
zone, starting at local midnight six dates ago. For example, October 27 includes
completions from October 21 at 00:00 onward. Local date arithmetic preserves
calendar-day semantics across daylight-saving changes. Current time advances
from the server sample and monotonic elapsed time after synchronization;
local-only summaries use their provisional client-time anchor. One project-owned
deadline updates Overview and Task list together at midnight, pauses while the
page is hidden, and recalculates on visibility recovery without requiring a new
snapshot.

Overview displays 20 top-level entries per page; Task chains and Standalone
tasks each display 15. A whole Goal is one entry regardless of expanded children; the single
standalone aggregate is one Overview entry. All display sequences sort by
`in_progress`, `todo`, then `done` before pagination, using individual status for
standalone tasks and complete component status for chains. Within a status,
exact newest-first order remains stable; the standalone aggregate follows
matching-status chains.
Pagination shows the current item range and filtered total with previous/next
controls; one-page results have no pager. Each list retains its own page during
the project visit. Changing Show all resets that list to page one; shrinking
results clamp the page immediately. These display slices do not truncate the
cached graph, statistics, Goal progress or dependency context, and do not add
requests or stored page preferences.

Clicking a progress row selects Task list and the matching category, switches to
the destination Goal's page, then scrolls, focuses and briefly highlights it.
The standalone aggregate selects its list's first page. Explicit positioning wins
over saved task-list scroll for that activation; ordinary category switches
keep the current page position. The [recent browsing decision](../../.agents/notes/implemented/feature/2026-10-27-recent-task-pages.md)
owns the shared window and paging policy; the [progress decision](../../.agents/notes/implemented/feature/2026-10-26-project-overview-progress.md)
retains the original aggregation and navigation rationale. The adjacent Task
list section contains Standalone tasks and Task chains. Desktop section navigation is vertical on the
left of the selected content; narrow screens use horizontal tabs with matching
keyboard direction. The outer choice is stored per project in browser
preferences, so the first render after reload or return already shows the saved
Overview or Task list selection. It does not change the URL or history. Empty
projects retain both section destinations.

Both sections use one `ProjectView` snapshot, synchronization loop and detail
owner. Task list mounts on first selection and stays mounted while hidden and
inert on Overview. Leaving Task list or its Task chains category closes the
current graph dialog and clears its temporary opening state; returning shows
the list without reopening it. The retained task subtree does not start another
cache, index or refresh loop. Task details remain outside either section panel.
Inactive inner-category contents unmount while their associated tabpanel IDs
remain stable.

Within Task list, an absent category preference selects Task chains; later
visits restore the project's last inner category. Both badges count unfinished
tasks (pending and in progress) from the complete snapshot, independently of
completed-item visibility, outer/inner selection and the open graph dialog. Their sum
equals the project's unfinished total; toolbars report all entries matching the
current filter against complete category totals, independently of page size.
Both categories default to all unfinished work plus completions in the local
calendar window. Their independent Show all controls include all history when
checked and restore the recent default when cleared. The label has no completed
count suffix; each choice retains its existing per-project browser record.

Chain membership is an ordinary-edge weak component: `dependsOn` contains all
prerequisites, while `externalDependsOn` marks edges that do not join
components. A normal `A → C ← B` creates one chain with two starting tasks and
one member set. A chain's representative is its earliest ordinary-root member
in exact service order; its title and creation ordering supply the top-level
chain row. Goal describes the browsing hierarchy rather than a stored task type
or a title-based membership rule. The header omits the Goal label and total/unfinished
summary. A localized in-progress count follows the title, including zero and the
representative while excluding external-only prerequisites. It counts only members
whose own status is `in_progress`, independently of aggregate status. Singletons with no ordinary incoming or outgoing edge are
standalone tasks, even when external prerequisites block execution. Status and
completion filters do not change membership. All edges still participate in
execution consistency and full prerequisite inspection.

Standalone rows are compact native detail triggers with title, individual
status, ID, creation time, automation permission and known execution timing. The
clock and duration follow creation time in the same wrapping information line. An
unfinished prerequisite produces an explicit Blocked / 被阻塞 badge. A Goal row
expands a task list through its main native button, independently of its
sibling View dependencies / 查看依赖关系 button. The list contains every other
ordinary-component member exactly once, with `in_progress` first, then `todo`,
then `done`. Completed children use exact `completedAt` descending order, with
unknown completion times last. Equal completion times and unknown-time ties retain
snapshot order, as do children in other status groups. Fresh snapshots recalculate
this order. Top-level Goal ordering remains independent. Other starting tasks in a merge are
included, while external prerequisite context is excluded. The
list always retains `done`, `in_progress` and `todo` children; completed tasks
remain visible. The chain-level Show all control changes whole-Goal visibility
and never filters children by status or completion date. Child rows show their own status,
applicable ready/blocked markers and known execution duration after the title,
and open the shared task dialog. The expanded heading offers the representative task's own
details. Aggregate progress still includes that representative. Chain rows
aggregate only component members: all done means done; otherwise any done or
in-progress member means in progress; otherwise any todo member means pending;
otherwise all members are todo. A completed representative with unfinished
members stays visible. External prerequisite context does not contribute to
chain progress or status. The former shared-membership badge is removed: a task
can recur as context while its actual component membership remains unique.

Each category retains its own completed visibility. Both share the current
task-list page position; category switching does not restore an older offset. Chain
ordering uses its representative's exact `(created_at,id)` service order,
reversed for newest first without lossy JavaScript timestamp conversion. The
open graph dialog keeps an original task witness only for the current reading
session and resolves its component after merges or splits without overwriting
a valid witness with a new representative. A removed, standalone, filtered or off-page
witness closes the dialog. Membership changes initialize a new bounded overview
and framing without remounting a same-representative canvas or active Details.
A representative change initializes the newly represented graph within the
current dialog. Ordinary status and clock refreshes retain visible S, viewport
and inspection under normal reconciliation.
The [task view decision](../../.agents/notes/implemented/feature/2026-10-22-project-task-views.md)
and [chain status decision](../../.agents/notes/implemented/bug-fix/2026-10-22-task-chain-status.md)
record their current rules and original rationale.

The runtime accepts todo, in_progress and done. The graph summary has six
counts: total, todo, inProgress, done, ready and blocked. They satisfy
`total = todo + inProgress + done` and `todo = ready + blocked`. Creation uses todo.
All-done chains are done; any done or in-progress member makes an unfinished
chain in progress; other chains are todo. External context does not affect progress.

The actual task title is the common dialog header and accessible name, with a
copy icon immediately to its right. The ID and its copy control belong to Overview.
The three-item status menu begins the shared state row beside the assignee
control, followed by platform and readiness, with automatic execution at the right.
Status, assignee and platform controls share a compact 24px height; the left group can wrap
on narrow screens. The menu remains available on every content tab, marks the current
item and permits selecting it. Arrow/Home/End, activation and
Escape preserve keyboard access and focus. Confirmation shows the full task name,
current/target states and timing consequences. Cancel is initially focused;
Cancel/close/Escape submits nothing. Long title and confirmation text have bounded
native scrolling; 320px retains controls without horizontal page overflow.

Status, allowAgents, requiredPlatform and assignedTo saves share one per-task
mutation owner. Operations that require confirmation share one confirmation union.
Reviewed identity/status/version and material inputs remain frozen; observed
changes invalidate confirmation. Exact bigint version survives JSON numeric
serialization without rounding. Same-state requires +0; actual change requires +1.
Same-state may return fresh derived readiness at the same version. Generation and
confirmed-version floor prevent older reads from restoring stale state.

Pending, stale, unknown or failed reconciliation blocks all task writes. Closing or
switching details retains original ownership. A confirmed result refreshes the
matching project graph while keeping panels, attachments, reading and focus.
Conflict rereads require fresh review. Unknown results keep the write error and
use GET-only reconciliation; observed state is not attributed to the uncertain
write. Failed reads keep both errors and offer GET retry. A 404 clears unavailable
private content while retaining unknown feedback. Identity replacement disposes
the old session; late responses cannot populate another task or identity.

Permission changes are forbidden during in_progress; automatic discovery requires
allowAgents=true, while explicitly designated execution accepts either value.
Ordinary and successful notices use three-second bubbles; errors and notices
with actions use eight seconds. Hover or focus pauses expiry. Close and expiry
change only presentation; unresolved recovery remains accessible from a compact
floating trigger, without changing write locks or replaying writes. Status does
not stop a process or provide delivery authority. The [status architecture](../../docs/design/daynight-task-status.md)
owns server rules, migration and timing. Actual service acceptance proves HTTP,
database and persistence behavior.

Task details share claim display and force withdrawal across the dialog,
standalone page and fullscreen. Active claims show the user, machine, agent and
phase; released claims are labeled, while completed history is not a current
claim. Project participant profiles supply nullable names and email addresses,
independently of the current-access owner that authorizes controls. The profile
reader retains loading, request errors and retry; a former participant remains
identified by its real user ID. A missing canonical profile is a roster error,
not a fabricated former participant or an empty profile. The
claimed heading has a bounded, focusable scroll region so full names, accounts,
machine names and member errors remain readable without consuming the tabs and
reading panels. This applies to dialog and standalone entries in normal and
fullscreen modes; short claimed views hide the informational footer and reuse
compact tabs, attachment padding and preview metadata layout. Short claimed
standalone pages also compact the auxiliary navigation bar spacing so complete
return links and language controls fit together at 320px in both languages
without consuming the attachment reading area. Keyboard
focus can reveal the withdrawal control within that region. Only
the original owner or a project admin sees **Force withdraw** for active/released
ownership; the service rechecks membership and authority.

Withdrawal confirmation freezes the task, claim and precise version. It explains
that the task returns to `todo`, worker ownership and execution timing are cleared,
and automatic execution is disabled. The remote agent may continue until its
worker synchronizes and cleans up; immediate stopping is not guaranteed. Cancel
submits nothing. The shared TaskDetailSession serializes the operation, validates
the returned reset while preserving other materials and refreshes the graph.
Conflicts require a fresh review; uncertain outcomes use GET-only reconciliation
without replay. This action does not require the original worker to be online.

Both lists use newest creation first, with descending IDs breaking equal-time
ties. Presentation reverses the exact API sequence without reducing timestamp
precision; updates do not move older tasks. Completed standalone tasks and
whole completed Goal chains are hidden by default in their respective
categories. Expanded child lists include all task statuses independently of
that filter. Each tab has its own completed-count checkbox,
visible/total count and per-project visibility preference. An empty category,
hidden all-complete items and a truly empty project have distinct states.
Revealing completed items focuses the persistent checkbox before the
empty-state action disappears. Long titles grow naturally in compact native
controls. Goal headers retain 7px row gaps and responsive progress widths; the
graph action can wrap on narrow screens. Desktop header titles stay 13px and
narrow-screen titles 12px. Child tasks use compact rows with visible individual
status.

Each mounted Goal row owns an initially collapsed disclosure state, separate
from graph opening. Several lists can be expanded at once. Same-row refreshes
and detail/graph round trips preserve that choice while updating current
members. Inactive inner categories unmount their rows, and filtering or
representative replacement can also remove a row; remounting starts collapsed.
Outer Overview switching retains the visited task subtree and its disclosure
choices. No disclosure state is stored in browser preferences. The [Goal-list
decision](../../.agents/notes/implemented/feature/2026-10-26-goal-task-lists.md)
owns this interaction.

The explicit View dependencies / 查看依赖关系 action opens one centered
dependency-graph dialog at a time without changing any disclosure state.
The toolbar selects horizontal or vertical direction and remembers it locally per project and representative task, defaulting to horizontal. Read, invalid-value and write failures are visible while direction changes remain usable. Switching preserves visible tasks and inspection, and reframes the current graph. Desktop geometry is `80vw × 80dvh`; at widths of 740px or less the dialog fills
the viewport except for 12px gutters. The title shows the chain name, status
and progress. Closing with the explicit button, backdrop or Escape restores the
original graph button or an available Goal disclosure, filter or list control
without changing the expanded lists, list height or page position. Complete P
contains every ordinary component member and every required ancestor through
all dependency kinds, without unrelated successors of context tasks. Main
progress counts component members only, and project counters count each project
task once. Actual visible S is progressive for members and context alike.
Dashed edges encode explicit external dependencies, including a shortcut inside
one ordinary component; dashed cards encode context outside that component.
Ordinary context edges stay solid. Details labels prerequisites, blockers and
successors using each edge's own marker; no dependency editor is added.

P with at most fifty tasks and one hundred dependencies is fully visible.
Larger P starts at the representative with stable undirected BFS, successors before prerequisites
in snapshot order; accept a task only when the complete induced graph remains
within fifty/one hundred, and traverse only accepted tasks. Cards expose direction
controls adding at most twenty hidden direct neighbors in P, with exact new-task,
new-induced-edge and remaining counts. Manual expansion has no edge cap. Every
real edge with both endpoints in S appears, without shortcuts or aggregate cards.

Cards are 220 by 96 pixels without hidden direct neighbors, using a 94px body
and two border pixels with no footer or separator. Cards with expansion controls
are 220 by 136, including a 40px two-column footer; an unused direction retains
its column. Each visible snapshot derives expansion data once. Layout, React
Flow, route ports, viewport fitting and keyboard reveal share actual dimensions.
The canvas separates native body inspection from sibling Details
and direction controls. Complete H drives visible ancestor/real-edge/arrow
highlighting and deduplicated hidden counts; same-card/blank clears. Inspection
does not expand, relayout, compile geometry or move the viewport. Details opens
the current dialog and relation navigation preserves graph selection.
Expansion centers its anchor at current zoom and focuses its body. Global reset
“收起到概览” recomputes/frames overview and retains reset focus.

Within the same topology scope, successful status/content refresh keeps actual
visible IDs still in new P plus the representative, prunes to its connected
visible subset and preserves the viewport. It does not add a new baseline or
newly arrived tasks. With the same representative, changed membership resets
only visible S, inspection and pending viewport actions; a topology-keyed
InitialViewport frames the new overview. TaskCanvas, ReactFlow and the graph-dialog
owner stay mounted, preserving fullscreen, active Details and their inert/scroll
locks. A changed representative initializes the corresponding graph within the
same open dialog. Reset computes a new baseline. Ordinary failure retains old
content only in the same identity/project/auth scope; current401 and resource
invalidation still unmount private content. Local S and inspection do not
persist. Locale translates controls without adding business reads. The
[progressive decision](../../.agents/notes/implemented/feature/2026-10-22-progressive-task-graph.md)
separates topology state from presentation lifetime.

Per-project browser preferences retain the selected outer section and inner task
category, one shared task-list page offset and each category's completed-item choice. Graph
dialog opening, witness, Goal disclosure, fullscreen, details and graph viewport are temporary;
the former `daynight:project-view:${projectId}` expansion record is not read or
written. The outer section uses the independent
`daynight:project-section:${projectId}` record with the JSON string `"overview"`
or `"tasks"`; a missing record selects Overview. A read or format failure selects
Overview with a section-specific notice; a write failure retains the current
in-memory selection and reports that it was not saved. Other preference errors
likewise leave the current page usable with visible feedback.

Both stable inner tabpanel wrappers retain their IDs and hide inactive content.
Task page scroll restoration and scroll/pagehide listeners are active only when
Task list is selected and a snapshot is available. Leaving Tasks saves its
shared position before Overview can restore its own per-mount memory
position. Overview starts at zero and never reads or overwrites the persisted
task offset. The JSON number at `daynight:task-list-scroll:${projectId}` is
restored on task-list entry, reload or project return. Inner category switching
does not call scroll restoration: the current offset stays within the new
document range, and shorter content can naturally clamp it to the bottom.
Returning to longer content does not recover an older category offset. The old
`daynight:task-view-scroll:${projectId}` record is no longer read or written.
Outer switches retain the already visited task subtree; inner
switches retain their conditional-content mounting. Graph dialogs close on
either departure and open only after a new dependency-graph action. Section/category
switching, filtering and scroll restoration make no API requests and do not
alter the complete project counters or prerequisites. The [preference decision](../../.agents/notes/archived/feature/2026-10-21-task-browsing-preferences.md)
records the original persistence rules; the
[shared-scroll decision](../../.agents/notes/implemented/bug-fix/2026-11-03-shared-task-list-scroll.md)
owns the shared offset and category-switch behavior.

The generic task and summary decoders require nullable assignedTo and a properties
object, preserving all property keys. Graph decoders also require assignedTo.
The PR business reader accepts an absent pullRequests key; a present
value must be an array of objects with string `url` and `title` fields. Missing
pullRequests and an empty array share the existing empty presentation while
remaining distinct data. A malformed present value produces the existing error
and retry state. String content, including NUL and arbitrary address text, is
preserved without defaults or content validation. The server graph decoder and
local graph projection retain compact nodes without properties.

Graph and detail reads require `externalDependsOn` alongside the complete
`dependsOn` set. The shared decoder canonicalizes UUIDs, rejects duplicates and
requires the external set to be a subset; missing or null fields are protocol
errors. Graph equality and detail freshness include classification, so a
marker-only change invalidates the corresponding content without inventing a
new timestamp. Clock-only samples still retain graph/index identity. Chain
membership uses ordinary-edge weak components; relationship labels and dashed
edges use the persisted marker independently of outside-component card context.
The complete model is specified in the
[external dependency design](../../docs/design/daynight-external-dependencies.md).

An open project automatically requests task-sync every fifteen seconds while the
document is visible. Hidden documents start no periodic reads; returning requests
immediately unless a sync is already active. Automatic ticks skip active syncs.
Manual refresh cancels the active read and starts immediately. Every successful
response updates the mount's clock receipt, including duplicate-only responses.
Detail content follows its own summary business version and project generation;
unchanged receipts do not cause GETs or detail writes. Receipt-driven recovery
still retries failed reads and raw graph disagreements. `GraphSnapshot.revision`
is zero for local-only summaries; positive values are the successful mount-local
receipt and online-admission signal, not a task version or durable commit counter. Equivalent
task data retains its index and layout; settings-only changes update Project
metadata without rebuilding task projections, and changed intrinsic data replaces
statistics and both task-category lists together. The
[automatic refresh decision](../../.agents/notes/implemented/feature/2026-10-22-project-task-auto-refresh.md)
owns the scheduling and scope. Production verification uses the real-service
journeys.

Same-resource, same-generation graph and detail refresh retain successful data
while loading and on recoverable failure. Errors remain in state during automatic retries until a
successful response clears them, including a failure before any successful read.
Project errors stay visible; task-detail bubbles expire while keeping recovery
reachable from the floating entry.
Automatic detail reads and queued follow-ups wait while the document is hidden;
requests already in flight may finish. A verified same-user project `404 not_found`
clears the project snapshot and persistent base; unavailable detail reads clear
their own data;
401 follows the authentication lifecycle and releases the workspace. A resource
change clears previous-resource content immediately. Same-task refresh keeps the
detail body mounted, preserving the active tab, PR page when its ordered values
are unchanged, focus, attachment selection, upload inputs, pending writes and
preview frame. Ordinary background reads add no heading progress paragraph,
so unchanged responses keep the heading, tabs and active reading panel bounds
stable before, during and after the request. Read errors, required freshness
and stale-snapshot feedback remain explicit through timed floating bubbles. The
[detail refresh decision](../../.agents/notes/implemented/bug-fix/2026-10-23-quiet-task-detail-refresh.md)
owns quiet polling; the
[notification decision](../../.agents/notes/implemented/bug-fix/2026-10-24-task-detail-notifications.md)
owns layout-independent feedback and recovery. Project and task changes release
the old resource state.
Project listing and attachment metadata/content keep their independent refresh actions.
Live detail never changes graph counters;
a changed prerequisite can alter readiness without revising the task itself.
The dialog offers a full graph refresh when that difference is observed.
Reopening or refreshing details reads current PR associations; an attribute
update changes the task timestamp and uses the same stale-snapshot prompt.

The canvas supports pan, zoom and fit while editing and connection controls
stay disabled. The toolbar offers Fullscreen viewing, which fills the browser
viewport with the same mounted dialog and canvas. Exit fullscreen or Escape
returns to the 80% dialog without resetting pan, zoom or nodes. One
graph-dialog owner isolates background controls and cycles Tab through its
visible controls in either mode. Clicking a heading, legend or blank canvas
keeps focus on the dialog so Escape continues to work. From that container, Tab
enters the first visible control and Shift+Tab enters the last. Leaving
fullscreen restores focus to its toggle. Task details remain available above
the graph. Escape handles one applicable layer at a time: nested menu or
confirmation, detail fullscreen, details, graph fullscreen, then the graph
dialog. Graph and detail dialogs share a counted body scroll lock so either
unmount order restores the original scrolling state. Neither dialog opening nor
fullscreen is saved as a browsing preference. The [graph-dialog
decision](../../.agents/notes/implemented/feature/2026-10-26-task-chain-graph-dialog.md)
owns graph presentation and preserves the original [fullscreen
rationale](../../.agents/notes/implemented/feature/2026-10-22-task-graph-fullscreen.md).
Each node has sibling native inspection, Details and direction controls. A long
graph starts with its root visible at readable zoom; keyboard focus brings
offscreen nodes into view. In normal mode, the centered body-portal dialog has
a 960px maximum width, 24px viewport gutters (12px at 600px and below), and a
maximum height of `min(880px, 100dvh - 2 × gutter)`. The persistent heading,
tabs and footer surround an Overview panel and an Attachments panel. Overview
owns its content scrolling and pairs a reading column with a 265px
metadata/relationship column (225px at 850px and below); at 600px and below it
stacks into one column. Attachments fills the panel with adjacent file and
preview panes at every supported width, including 320px. Its parent body and
panels do not scroll. Short viewports, including 844×390, use compact heading
and control spacing to retain usable content without a second outer scrollbar.
The dialog locks background focus and scrolling, supports its close button,
backdrop, Escape and Tab, and restores a surviving original trigger or a
visible control in the active task view on close. Focusable controls are
enumerated with `tabbable` 6.5.0 using its normal browser visibility checks.
Same-origin preview frames bridge Escape and first/last Tab boundaries back
into the active reading container. Passive unmount restoration remains
responsible for focusing a surviving trigger after DOM removal.

The title-bar Enter fullscreen/Exit fullscreen button fills the browser content
area with the same mounted Surface in both dialog and standalone entries. The
outer reading workspace owns this transient mode: relationship navigation retains
it, while closing and reopening starts normal mode. Mode changes preserve the
portal, task/tab/file selection, native file input, attachment controller, frame
URL/identity, drafts and pending mutation session, with no new business requests.
Application scroll containers restore their prior offsets within the new layout
limits, including positions near the end. Exit focuses the same toggle without
scrolling. CSS viewport sizing retains the title, actions and internal scroll
owners at 320px/390px and short heights. At heights up to 500px, fullscreen
uses a compact header for title/actions, a metadata-control row with a wrapping
left group, and tighter tabs and panel padding; the informational footer is hidden. The full title stays in
a focusable one-line-height scroll region. The task action-menu trigger and
attachment popout icons retain their accessible labels. The preview header keeps
path/metadata context and actions on one row, preserving full strings through
DOM/title text.
The claimed body heading additionally retains its bounded scroll region in both
normal and fullscreen modes, including long identity and machine text. The
combined sizing leaves readable nonzero Overview and preview bodies at 320×240. Verification observes body/frame dimensions, actual content paint
and scrolling; visible controls alone do not establish reading access. The
[fullscreen-reading decision](../../.agents/notes/implemented/feature/2026-10-25-task-detail-fullscreen.md)
records mode, scroll and keyboard ownership.

## Markdown task descriptions

Task descriptions render CommonMark and GFM using the same `MarkdownContent`
renderer and styles as Markdown attachments: headings, paragraphs, lists,
checkboxes, quotes, fenced code, tables, links and images. Mermaid fences render
static flowcharts under the
[shared diagram requirements](../../docs/spec/daynight-task-inspection.md#markdown-流程图).
Raw HTML remains text;
URL protocols retain the renderer's existing policy. Empty descriptions use the
current interface language. Markdown and localized messages do not change the
stored string or CLI/API output. Wide tables and code scroll within their local
regions, and long words wrap inside the Overview reading column at 320px.

Description-relative links and images resolve from the task attachment root.
Markdown attachments resolve from their containing file's directory. Both use
the actual preview URL and reject references that escape the root. An ordinary
primary click on a relative attachment link without a query or fragment opens
the existing Attachments tab, selects that exact path through its shared
controller, and focuses the preview pane. The anchor retains its real preview
href for modified clicks, context menus and native navigation. Absolute,
root-relative, protocol, fragment and query/fragment links retain native behavior.
The selected file's separate Open in new tab action continues to use the
standalone reader.

Pending inventory, incomplete-list failure with retry, invalid references,
missing files and preview failures remain visible and distinct. Only the
complete paginated inventory can establish that a path is missing. Description
navigation does not create another inventory or preview owner; task changes,
close and existing authentication invalidation release its requests and state.
Same-path overwrite and explicit attachment refresh retain the existing revision
and preview reload behavior.

Mermaid 12.2.0 loads on demand for `mermaid` fenced blocks. `flowchart` and `graph`
provide nodes, arrows, branches, Chinese labels and TD/LR directions. A block
accepts at most 50,000 UTF-16 code units and 500 edges; limits use the same local
error/source presentation. Each diagram has independent loading/error feedback and inspectable source; an invalid block
does not interrupt the document or other diagrams. Before drawing, the pinned
Mermaid parser identifies image nodes, including escaped metadata keys. A node
with an image resource or `imageSquare` type receives an explicit localized
refusal and visible source, without occupying the rendering queue. Ordinary
shape metadata and literal `@{` labels keep their normal Mermaid meaning.
Supporting image nodes requires an interruptible isolated rendering context;
a timeout alone cannot interrupt Mermaid's internal image decoding or release
its shared state. Successful diagrams are inert SVG images. Diagram directives
and frontmatter cannot override application security or theme configuration.
Custom style resources and ordinary Markdown images retain normal browser
resource behavior; flowchart rendering is not network-isolated. The current
light palette matches Markdown;
wide diagrams retain readable labels in a focusable local scroll region at
320px. Task/attachment changes and unmount invalidate obsolete render results
and release owned rendering resources. The
[flowchart design](../../docs/design/daynight-task-inspection.md#mermaid-流程图)
owns staging, serialization and image lifetime.

## Task attachments

Task details opened from the project list or graph start on Overview, which
retains descriptions, PR associations, relationships and metadata. Standalone
addresses initialize the tab and attachment selection from their navigation state.
The complete task ID appears only in its metadata row, beside the same overlapping
squares copy icon used immediately after the loaded title. Both buttons retain
localized accessible names, hover titles and native keyboard activation. The shared
`TaskCopyButton` writes the exact complete title or ID with
`navigator.clipboard.writeText`, disables its button while pending and exposes
success or a recoverable failure through timed bubbles. The original text remains
selectable after a failure. The title button is scoped to project/task and title
value, and the ID button to its complete ID; unmount invalidates late results.
The separate Attachments tab places the path-addressed file tree, refresh and upload on the
left and the selected file's preview on the right. A vertical divider separates independently
scrollable panes; narrow layouts retain this left/right placement. The
[split-view decision](../../.agents/notes/implemented/architecture/2026-10-22-task-attachment-split-view.md)
owns this composition and its scroll rules.

`TaskDetailPanels` keeps both panels mounted with stable tab relationships. The
active tab is the sole roving tab stop; arrows and Home/End activate its neighbor
or endpoint, and native Enter/Space work normally. Hidden panels are both hidden
and inert. Returning to Attachments retains selection, expanded directories,
loaded state, preview and an unsent file/path draft. Changing project/task resets
the tab and attachment scope. Description-to-attachment navigation activates this
same panel and controller.

The file tree initially shows only root files and first-level directory names;
all directories start closed. Native directory disclosures support pointer and
keyboard operation. Manual expansion survives attachment refreshes, tab and locale
changes, and ordinary rerenders within the same project/task. Description links,
direct attachment URLs and history restoration of an attachment path reveal only
the target's ancestor directories, retaining other manual choices. A user can
collapse the selected file's directory afterward; refresh and tab changes do not
reopen it. Repeating the same description link reveals its ancestors again.
Tree selection and successful uploads do not request directory expansion, including
when they update the standalone address. A project/task change resets disclosure.
The [directory-disclosure decision](../../.agents/notes/implemented/feature/2026-10-25-attachment-directory-disclosure.md)
owns the separation between selection and navigation reveal.

The upload section starts collapsed. Activate Upload with a click or the
keyboard to expand it, then select one local file, accept its name as the initial
target or edit the relative path, and upload. Activating the disclosure again
collapses it while retaining the file, path and validation state. Tab round trips
retain its expansion; a new project/task starts collapsed. MIME is selected
from the target path with `mime` 4.1.1. Uploading the same path overwrites that file. Each preview offers Download,
a neighboring Open in new tab link with an external-link icon. Each left-side file row has a right-side `…` menu. Choose Delete to open a full-path confirmation, then explicitly confirm to submit the single-file request. Cancel is initially focused; menu and confirmation Escape close only their own layer. Pending confirmation blocks duplicate/conflicting writes, while failures remain visible with deliberate retry or cancellation. The confirmation includes the current language selector. Hidden tabs dismiss unsubmitted deletion UI. Successful writes refresh only attachment data.
They do not change the task version, timestamp or graph snapshot.

The attachment hook owns list, write, selection and preview state for one
project/task identity. It follows all pages, keeps already-read files when a
later page fails and labels the result incomplete with a retry action. Scope
changes and unmount cancel requests; generations discard late results. List,
write and preview errors stay local. An overwrite or a refreshed `updatedAt`
reloads the selected content and remounts native previews; the server's
`Cache-Control: no-store` keeps mutable paths current. Empty inventory and no
selection have distinct states; deleting the selected file clears its preview, while deleting another file preserves the loaded preview and reading position. A failed delete retains the last-known row and preview without promising server-side rollback under K1.

The right preview has one vertical scroll owner. Markdown, text/JSON/source and
large images use `attachment-preview-body`; their renderers have no nested
vertical height limits. Tables and code can scroll horizontally. For ready
HTML/PDF, the body and fitted frame wrapper hide overflow and the embedded
document or native reader owns scrolling. The preview header never scrolls
independently, exposes the complete path and keeps Download and Open in new tab reachable. File-row menus and confirmation controls remain accessible at narrow widths.
Left-pane scrolling does not move right-side content or its reading position.
The standalone complete details reuse this panel, rendering and sizing; their
outer composition integrates task, tab and file navigation with URL and history. Independent
real-service runtime acceptance of the attachment-reading group is complete.
Its source, build, browser and cleanup receipts retain the scope of that result;
a local browser override does not establish hosted-CI browser behavior.

Markdown uses `react-markdown` 10.1.0 with `remark-gfm` 4.0.1 for CommonMark and GFM
including tables, plus the shared static Mermaid flowcharts described above.
The embedded preview and standalone reader retain the same per-diagram error,
source, lifecycle and narrow-layout behavior. Raw HTML remains escaped. Relative
images and links resolve
from the Markdown file's directory to the task preview route; standalone `#fragment`
links remain on the rendered document. Paths that escape the task root are
rejected. Text, JSON and source previews preserve text and newlines. Images use
native image loading with error/retry feedback; PDF and HTML use native iframes.
HTML/PDF first check preview availability with HEAD and never decode a HEAD error
as a JSON body. The frame then performs normal resource requests. HEAD success
does not prove that native content has rendered; integrated acceptance must
observe actual HTML interaction and PDF output.

HTML loads the fixed same-origin
`/api/v1/projects/{projectId}/tasks/{taskId}/preview/{path...}` URL. Its CSS, JS,
images and relative fetches follow normal browser URL rules. HTML is trusted
project code with main-origin privileges; the ordinary iframe has no sandbox.
There is no separate preview modal, session token, domain or Service Worker.
The [authentication architecture](../../docs/design/daynight-auth.md) enforces
credentials at HTTP admission and project membership in the pre-I/O snapshot.
Admitted operations may finish without a later membership recheck, retaining
this trusted same-origin execution model, relative resources, keyboard behavior
and the K1 filesystem/PostgreSQL limitation.
Other formats show metadata and a download link. Files and metadata can diverge
after a failed write under the accepted K1 limitation; the UI reports errors and
does not implement reconciliation or rollback.

### Standalone complete task details

The default graph/list entry still opens the centered `TaskDetailDialog`. Its
title-bar More task actions menu has a real Open in new tab anchor with
`target="_blank"` and `rel="noopener noreferrer"`, preserving the current task,
current tab and selected attachment. The source dialog remains open with its local
state. A preview's neighboring Open in new tab action enters the same complete
task details at that file, even while preview content is loading.

`TaskDetailSurface` shares the full content and existing actions between dialog
and page: description, status, relationships, PRs, metadata, three-state setting,
automatic-execution permission, execution platform, assignee and attachment management.
`TaskDetailDialog` retains the modal portal, inertness, scroll lock, focus loop
and focus restoration. `TaskDetailPage` provides an ordinary full-page container,
return-to-project link and language selector. Their outer workspaces own fullscreen
mode and the shared Surface handles layered Escape. Standalone fullscreen hides
the auxiliary top bar while keeping an explicit return-to-project link in the
title bar; exit restores normal page controls. The assignee picker and platform select
stay in the status row, with its lock explanation in a hover/focus tooltip
and operation feedback in the shared floating layer. Status, permission and
platform use the same confirmation/review owner; assignment uses the same mutation
gate and review freshness. File deletion keeps its own
modal confirmation. These interactions remain available in either container.
Ordinary standalone mode retains native page and frame keys. Fullscreen supplies
an `AttachmentKeyboardOwner` with the active reading root and `onEscape`; the
already-loaded same-origin frame updates its listeners without reloading. The
bridge adds a final Window handler for each Escape/Tab event after the child
application's current Window consumers, so consumed shortcuts retain precedence
while boundary Tab remains synchronous. Abortable cleanup also works after the
frame navigates cross-origin. Exiting releases the standalone bridge; ordinary page
Escape does not navigate or close the window. Native PDF readers may not expose
a controllable document: HTML keyboard proof does not establish PDF key behavior,
and explicit exit/return controls remain available.

`/projects/{projectId}/tasks/{taskId}` defaults to Overview. The existing
`/projects/{projectId}/tasks/{taskId}/attachments/{path...}` defaults to
Attachments with that exact file selected.
`tab=overview|attachments|discussion|session` can explicitly select a tab;
Session falls back to Overview when no Session panel is available. With no file selected, Attachments uses the base task
URL with `?tab=attachments`; a hidden file selection can remain in an attachment
path with `?tab=overview`. `taskDetailUrl` builds those URLs from
`TaskDetailNavigation`. The app observes both pathname and search, and login
return navigation retains navigation query parameters so authentication does not
lose the tab. The login-start target removes transient `authError` feedback,
preventing an old login failure from surviving a successful return.

Standalone relationship navigation, tab changes, file selection and successful
upload selection synchronize the address and add history only for a new state.
Back/Forward apply the address state without adding an entry; copying or reloading
restores the task, tab and file. Modal relationship/tab/file changes stay local
and do not write the project URL or history. A same-task tab/file route change
keeps the shared surface and attachment controller mounted, retaining directory
disclosure, sidebar scroll and upload drafts. Task and authenticated-identity
changes preserve the existing cancellation and state-isolation rules.

The page owns a real `useTaskGraph` snapshot for relationship titles, successors
and freshness, then composes the shared detail session. Initial loading, initial
failure and retained-snapshot refresh errors stay distinct; failure cannot become
an empty graph. Retained-snapshot errors use the shared floating layer inside
the detail surface, as do the page language selector's preference-storage notices,
preserving tab and reading geometry. Matching persistent detail content is
available only after this mount's successful project sync, and opening still
performs a live GET before writes. Task business versions, project generations
and recovery needs drive later reads; clock-only graph receipts do not reread
unchanged details. Same-identity foreground auth
revalidation retains ordinary page visibility, interaction and component identity.
Unchanged detail refreshes retain focus, inputs, preview and heading/panel geometry.
Each window reads its own resources; task objects, snapshots and confirmations
are not transferred from the opener. Existing precise-version writes, conflicts
and unknown-outcome reconciliation remain owned by `TaskDetailSession`.

The [inspection requirements](../../docs/spec/daynight-task-inspection.md#独立完整任务详情),
[design](../../docs/design/daynight-task-inspection.md#独立完整任务详情) and
[standalone-detail decision](../../.agents/notes/implemented/architecture/2026-10-24-standalone-task-detail.md)
own complete-page behavior and composition.

### Standalone attachment reader

Attachment links now open complete task details at the selected file, using the
same `TaskDetailReading` and `TaskAttachmentsPanel` as the modal. One attachment
controller serves description navigation, directory tree, refresh, upload,
row menus, deletion confirmation and preview. Complete inventory is required to
establish new-path metadata or absence; partial failures remain visible with retry,
and confirmed same-task/path metadata survives incomplete refreshes. Deleting
the selected file keeps its URL and displays missing after complete confirmation;
deleting another file preserves the current preview and reading position.

The parser splits the raw path before decoding segments once and applies the
existing canonical-ID and attachment-path validators. Encoded separators and
traversal are rejected; `%252F` represents a literal `%2F` in a filename. Go serves
the same index for GET/HEAD of the base task and attachment page shapes, rejects
other methods with 405 and `Allow: GET, HEAD`, and keeps unknown shapes as JSON
404. Invalid page IDs retain index plus frontend not-found behavior. The raw
attachment guard runs before ServeMux normalization; file endpoints keep their
existing scope and authorization checks.

The full-page detail allocates remaining height after its actual heading and
tabs. Shared attachment panes stay adjacent at narrow widths and own their scroll
independently. Markdown/text/images use the preview body; fitted HTML/PDF frames
use their documents' scrolling, without another vertical wrapper. No fixed
heading-height subtraction, extra renderer, metadata API or preview credential
is introduced. The [full-reader decision](../../.agents/notes/implemented/architecture/2026-10-22-task-attachment-full-reader.md)
retains routing/rendering foundations and the
[shared-page decision](../../.agents/notes/implemented/architecture/2026-10-24-shared-attachment-page.md)
retains full attachment-panel reuse rationale; complete Task Detail composition
now belongs to the standalone-detail decision. The production `task-detail-page`
and `task-attachments` journeys use actual services on both runtime targets with
source-qualified receipts.

## Validation and build

```bash
pnpm web:typecheck
pnpm web:build
pnpm web:test
```

The build typechecks the package and emits production HTML and hashed assets to
`packages/daynight-web/dist/`. `scripts/publish-assets.mts` validates the index,
its local asset references and ordinary files, prepares a complete staged copy,
and replaces `packages/daynight-server/internal/webui/dist/`. Failed validation
or publication fails the build; a failed swap attempts to restore previous assets
and reports both causes if rollback also fails.
The Go binary embeds the published output. Both generated directories are ignored
by Git, and clean server builds require this explicit build first. The Go
`scripts/check.sh` invokes the same command before build/vet/race/go-cov.
The existing root `build`, `test` and `acceptance` commands retain their CLI scope.

`web:test` serially composes two required package commands. `test:harness` runs
all Node acceptance/tooling harness tests, including the coverage checker,
asset publication and acceptance receipts. `test:coverage` runs the ordinary
Vitest suite with V8 coverage and then the exact statement gate. Full-scale graph,
model and geometry workloads live in `.stress.ts` files and run only through
`pnpm test:stress` from this package (`pnpm web:test:stress` from the repository
root). Its dedicated `vitest.stress.config.ts` refuses CI; ordinary discovery
excludes those files while retaining compact correctness and boundary cases. Either command can be
run directly with `pnpm --filter @codetreker/daynight-web test:harness` or
`pnpm --filter @codetreker/daynight-web test:coverage`; `pnpm web:test` remains the
complete local gate. All `src/**/*.ts` and `src/**/*.tsx` files belong
to the product manifest, including the browser entry. Tests live outside `src`.
The checker independently compares that manifest against `statementMap` and `s`
in `.tmp/coverage/coverage-final.json`; missing runtime files fail even when they
were never imported by a test. Empty, malformed and incomplete reports fail.

The platform, pause, status and assignment controller session tests use
`tests/helpers/waitForState.ts` for non-DOM state changes. It delegates to
Testing Library with a 5ms default polling interval, preserving immediate
checks, timeouts, errors and explicit options. DOM tests keep their existing
waits. The [state polling decision](../../.agents/notes/implemented/testing/2026-11-04-web-controller-state-polling.md)
records the cadence and its limits.

The focused navigation browser suite builds a minimal editor host from the
production router, admitted-location owner and task confirmation. It checks draft
admission independently of Steps forms and HTTP writes, including indexed
history traversal, retirement, beforeunload, keyboard focus and both languages at
320px. Run `pnpm --filter @codetreker/daynight-web exec playwright test --config
tests/navigation/playwright.config.ts` after installing Chromium. Browser CI
shard 2 runs all 28 cases before its full-stack acceptance. Its results and failure captures
are written to `packages/daynight-web/.tmp/acceptance/navigation-contract/`,
inside the browser CI artifact directory.

The required comparison is `covered * 10 > total * 9` using BigInt. Exactly 90%
fails independently of display rounding. Pure-type declarations contribute zero
statements only after the pinned TypeScript compiler's emitted JavaScript proves
that they have no runtime body. Temporary native compiler inputs and outputs live
under this package's `.tmp/` and are removed after classification. Typechecking
remains a separate mandatory check; classification is not a substitute for it.

PR CI selects affected modules using the [repository routing rules](../../README.md#ci-selection);
main pushes run the full suite. The Web selector enables `verify-web-quality`
and a two-entry `verify-web` matrix. Each job keeps a 20-minute bound. The final
`checks` job retains the general `success`/unselected-`skipped` gate and additionally
requires selected Web quality and matrix results to be `success`. Missing,
failed, cancelled or skipped selected validation cannot pass. Shared workflow
changes retain all-module selection.

`node packages/daynight-web/scripts/ci.mts quality` runs `test:harness`, complete
Vitest/V8 collection and `scripts/coverage.mts` serially. Harness has a 180-second
deadline, collection has a 300-second deadline, and final source-inventory and
strict coverage verification has its own 60-second deadline. Completed collection
cannot consume the final checker's budget. The
[stage budget decision](../../.agents/notes/implemented/testing/2026-11-04-web-coverage-finalization-budget.md)
owns that separation. Only the Vitest/V8 child receives a copied environment with
`VITEST_MAX_WORKERS=4`, retaining its `forks` pool, per-file isolation, full product
manifest and strict statement gate. The
[worker capacity decision](../../.agents/notes/implemented/testing/2026-10-28-web-quality-worker-capacity.md)
calibrates that resource setting for the dedicated public standard Linux runner's
four CPUs. Scale workloads use the separate local stress configuration.

The browser matrix invokes `node packages/daynight-web/scripts/ci.mts browser
--shard=1/2` or `--shard=2/2`. Both install pinned Chromium and Linux dependencies
under the existing 600-second bound, build real embedded Go targets and own
independent native/container services, databases, private credentials and cleanup.
Playwright selects cases with `--fully-parallel --workers=1 --retries=0
--shard=i/2`: fully-parallel controls case-level partitioning, while each database
still executes one browser worker serially. The current canonical inventory is
32 scenarios, divided into disjoint sets of 16. Default file-level partitioning
would produce a 24/8 split for this inventory.

Before preparing services, the runner collects the complete canonical functional
inventory and the selected shard using the same functional arguments as the
actual run. It records only the validated selected scenario IDs. Native and
container phases execute that same selection; the callback derives it from its
existing source/run-bound parent receipt. Invalid identities, collection errors,
unknown/duplicate/missing scenarios or a mismatched selection fail validation.
The pure `scripts/acceptance/inventory.mts` owns canonical functional and
combined-authentication check names.

Shard 2 owns the complete 28-case navigation-contract suite, dev-ci lifecycle
fixtures, both eleven-check combined-authentication journeys, and the real
attachment persistence/paired-backup-restoration check. Ownership derives from
the shard identity. Shard 1 runs its functional selection and full owned-resource
cleanup. Both entries retain normal dev-ci built/running image checks, private
browser profiles, source validation and the CLI cleanup barrier. Matrix
`fail-fast` is false so one failure does not cancel the other entry's diagnostics
and cleanup.

The CI wrapper requires each owned command group to stop after settlement,
not merely its leader. Command, cancellation and cleanup failures remain failures,
including combined errors. Native preparation installs the shared CLI before an
atomic, run/source-bound permission releases the container browser. Selected
native/container phases overlap against independent service, database,
authentication and storage resources. The container permission wait remains
900 seconds. Run-wide CLI recovery waits until both targets drain; combined CLI
commands receive cancellation without terminating commands in the other target.
The [functional target decision](../../.agents/notes/implemented/testing/2026-11-04-web-functional-target-overlap.md)
owns those isolation constraints; the
[quality isolation decision](../../.agents/notes/implemented/testing/2026-10-26-web-quality-job-isolation.md)
owns the separate quality workload and command budgets.

Quality uploads `coverage-final.json` and `summary.json` as
`daynight-web-coverage`. Browser entries upload full evidence as
`daynight-web-acceptance-1` and `daynight-web-acceptance-2`; shard 2 includes
navigation and persistence receipts. Each also uploads its existing
`acceptance/*/evidence.json` as `daynight-web-summary-1` or `daynight-web-summary-2`,
preserving `runID/evidence.json`. The existing final `checks` job downloads only
these small JSON summaries. All artifact families retain 30 days.

For selected Web validation, that final job checks out its current source, sets
up Node 24, downloads both exact summary names, and invokes the install-free
`scripts/acceptance/report.mts --shards file1 file2` validator. It requires exactly
shards 1/2 and 2/2 with distinct run IDs, clean passing receipts, the current
`GITHUB_SHA` and checkout tree, accurate native/container targets and browser/CLI
cleanup, matching selected inventories, disjoint canonical unions and both
complete combined-authentication receipts owned only by shard 2. Missing or
inconsistent evidence fails the same required gate. No executable, image or
resource ownership is transferred between runners. The
[two-shard decision](../../.agents/notes/implemented/testing/2026-11-04-web-ci-case-shards.md)
records duplication costs and performance-model limits.

Default local `pnpm web:acceptance` retains complete unsharded functional and
combined-authentication validation with its preinstalled browser. Explicit local
stress runs capacity last after functional, container, browser and CLI barriers;
a stress/shard combination is rejected before preparation. Browser jobs select
official Ubuntu archives before installation, as delivered in
[PR #148](https://github.com/codetreker/daynight/pull/148). Go module/compiler caches
remain reusable. The
[pipeline decision](../../.agents/notes/archived/testing/2026-10-21-web-acceptance-pipeline.md)
records the original scheduling and ownership choices. The
[deployment decision](../../.agents/notes/archived/architecture/2026-10-20-embedded-dashboard-deployment.md)
records embedded HTTP/container smoke checks and concurrent dev-ci isolation;
the [production acceptance decision](../../.agents/notes/archived/testing/2026-10-20-dashboard-production-acceptance.md)
records the separate real-Docker fault matrix and its limits. CI repeats the
controlled lifecycle fixtures and full production-browser suite. Manual Docker
fault testing and controlled fixtures each retain their own evidence scope.

## Production browser acceptance

On a Linux or macOS host, with Go 1.27.2, Docker Engine 28+, Compose 2.20+ and Linux
containers available, run from the repository root to install the pinned browser
into the project:

```bash
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.tmp/playwright-browsers"
pnpm --filter @codetreker/daynight-web exec playwright install chromium
pnpm web:acceptance
# Explicit local capacity and timing matrix:
pnpm web:acceptance:stress
```

The ordinary local command requires thirty-two functional scenarios on each
native/container target, sixty-four in total. CI retains that complete inventory
across two disjoint case shards, each running its sixteen selected scenarios on
both targets. The explicit local stress command adds five native
capacity/limit scenarios and their performance receipt. From this package, use
`pnpm test:stress:browser`, or invoke `node scripts/acceptance.mts --stress`;
`--apfs --stress` combines the local capacity matrix with explicit APFS storage.
Stress mode is refused in CI and cannot be combined with a shard before fixture
preparation. Raw Playwright selection excludes the capacity spec by default and
rejects a stress selection in CI. Both local modes retain combined authentication,
exact source/browser identity and full cleanup; CI runs the two combined journeys
on shard 2 while every shard performs its owned cleanup.

Use Node 24, pnpm 11.28.6 and a frozen dependency install first. Chromium requires
its normal runtime libraries on Linux; CI installs them with Playwright's
`--with-deps` option. Locally, `DAYNIGHT_BROWSER_EXECUTABLE` can select an existing
Chromium executable. That override is recorded and is forbidden for CI delivery
evidence, which must use the full bundled Chromium channel (`chromium`) pinned by
Playwright 1.64.1. This channel renders PDF pages; MIME-document readiness alone
is not a painted-content oracle. Native and container phases record and require
the same browser identity. macOS also requires Xcode Command Line Tools (the Apple
SDK and `xcrun clang`). The runner compiles its process inspection helper into
project temporary storage. Default acceptance uses an owned ordinary directory,
including on a case-insensitive Mac disk, without creating or attaching images.
Linux still requires a case-sensitive directory. The storage receipt records
the measured `caseSensitive` capability and each browser phase records
`caseSensitiveStorage`. Native Mac phases without that capability use a
non-colliding attachment fixture path; Linux and container phases retain the
case-sensitive fixture. A normal Mac pass does not claim native case-coexistence
coverage. Windows native Web acceptance is unsupported.

Routine `pnpm web:test` does not attach disk images on macOS. It checks storage
receipts and refusal paths without requesting disk authorization. Run the explicit
`pnpm web:test:storage-native` suite for APFS lifecycle checks; its cases share
one mounted image, including a real read-only file holder that prevents the first
detach and releases the file before cleanup retries. For a complete native Web
run with case-sensitive storage on a Mac, explicitly run
`pnpm web:acceptance:apfs`. It uses one owned case-sensitive APFS sparse image
when the parent filesystem folds case. These diagnostic commands may request
macOS disk authorization; routine development and validation do not need them.
Receipts are persisted before attachment and server startup. Cleanup confirms
the server stopped, validates image/mount ownership, detaches normally, and only
then removes storage. Busy detach retries share one 30-second deadline with
ownership revalidation. Uncertain ownership fails without recursive removal.
Existing recovery commands remain available without opting into new attachment.

The full CI workflow remains on Linux and retains case-sensitive storage coverage.
macOS local acceptance runs the same sixty-four functional scenarios and
additional combined authentication checks, with native filesystem coverage
qualified by its recorded capability. Explicit local stress acceptance adds the
same five capacity/limit scenarios and fixed performance budgets on Linux and
macOS. A local pass does not establish
macOS CI coverage. The [filesystem coverage decision](../../.agents/notes/implemented/testing/2026-10-23-native-development-filesystem-coverage.md)
owns this distinction. For networks requiring an npm mirror, use
`pnpm install --frozen-lockfile --registry=https://mirrors.cloud.tencent.com/npm/`
for the workspace. Export `pnpm_config_registry=https://mirrors.cloud.tencent.com/npm/` for the
acceptance CLI installation, and `DAYNIGHT_NPM_REGISTRY` for Docker builds. Both Compose stacks default to the official
npm registry unless the build variable is explicitly supplied.

The command builds real embedded assets and a new Go executable and owns a
separate PostgreSQL container/volume and ephemeral loopback listener. In parallel,
the normal dev-ci runner builds and starts the actual production image. Browser
execution overlaps the same selected functional scenarios in native and
production-image stream-gateway targets. Local ordinary execution selects all
thirty-two scenarios; each CI shard selects sixteen and the final gate requires
the complete disjoint union. Explicit local stress mode then runs five native
capacity/limit scenarios. In
that mode, the native process and PostgreSQL remain alive through capacity;
other preparation commands and the complete container stack finish before it
starts. No normal localhost service or dataset is used. Functional and
capacity fixtures use normal UniAuth-acquired sessions/PATs and real write APIs.
The shared gateway fixture is pinned to
`0978963813fcefd9d553f6cb9bcc319084c764b3`; App credentials, browser session and PAT
metadata remain in private 0600 files outside public artifact trees. External
provider HTTP responses are controlled, so this proves the real gateway/SDK
protocol and differs from a real upstream-provider login. The graph scenarios and `project-view-tabs` retain GET/HEAD-only browser checks
except for one exact registered fixture-file PUT in `refresh-staleness`, which
holds its upload response across automatic reads to verify retained pending work.
`task-attachments` and
`language-state-preservation` allow exact fixture-scoped PUT/DELETE file routes;
the latter holds each upload, overwrite and deletion while changing language to
verify one write and retained state. `task-description-markdown` and the other
language scenarios remain GET/HEAD-only in the browser; fixture writes use the
installed CLI or authenticated API request context. The three task-status scenarios
and `task-status-transitions` separately admit only registered project/task PUT status requests with exact expected
counts. Six authentication scenarios declare only their exact expected management writes;
unrelated browser mutations remain failures. The `project-settings` journey
admits exactly four registered project-settings PATCHes: successful save, stale
conflict, committed response loss and demoted-member refusal. Other users and
administrative preparation use authenticated request contexts; a failed read
reconciliation can be recovered only by an explicit read retry, without a fifth
browser PATCH. The `task-execution-time` journey keeps the browser GET/HEAD-only;
real service/API and installed CLI prepare timing, save thresholds and complete
work while controlled browser receipt delivery isolates the local ticker.

The `task-assignment` journey admits only exact registered assignee PATCHes and
checks real set/clear writes, same-value zero writes, conflicts, committed response
loss and GET-only recovery with preserved task materials. The
`task-assignment-layout` journey covers bilingual 1366px/390px/320px layouts,
long/null names, avatar failure, popup/focus/scroll/fullscreen behavior, former
members, read-only browsing, local filters and complete progress with hidden
siblings.

The `task-pause` journey verifies pause discovery in the project overview,
standalone and chain lists, dependency graph and common detail heading. It admits
only registered exact-version Unpause PATCHes, checks preserved task materials,
pending protection, stale conflicts and committed-response-loss GET-only
reconciliation, and covers English/Chinese narrow layouts. Pause counts retain
their complete project/component scope independently of status and list filters.

The [status journeys](tests/e2e/status.spec.ts) are task-status,
task-status-conflicts, task-status-recovery and task-status-transitions. Within
one Playwright worker incarnation and exact service origin, they share an
Alice API PAT, a separately acquired CLI PAT/client, and a project created through
the installed CLI. Each case opens a fresh API request context and independently
validates the installed package's source and artifact hashes. Its command, write
and snapshot receipt remains case-owned. The shared setup receipt records the
actual project-creation command once; case receipts reference that source-qualified
receipt. Worker teardown drains preparation and closes its owned CLI client.

The automatic-permission, platform and assignment journeys share only a project
within the same worker. Their API authentication stays case-owned, and assignment
retains its normal Bob login, invitation and acceptance assertions. All seven
journeys retain fresh browser contexts, pages, storage and normal browser logins;
each creates its own mutable tasks and retains its exact write/fault assertions.
A common worker-fixture registration and test-scoped family option preserve
worker-pool reuse. Restarted workers prepare new resources. The
[shared preparation decision](../../.agents/notes/implemented/testing/2026-11-04-web-scenario-preparation.md)
records ownership and measurement limits.

Origin, method, headers and body pass through the redacting authenticated wrapper
unchanged; receipts exclude credentials. The status-transition extension was
validated against its 28-per-target functional inventory with five additional
native capacity/limit checks (61 combined); the current complete inventory below
also includes later functional scenarios.

The journeys exercise direct completion, reopening, all three states, current
same-state no-op, exact stale conflicts and shared status/permission ownership.
CLI readback verifies ready/list/graph, full materials, PRs, dependency classification,
timing and attachment bytes. Starting/finishing blocked tasks and reopening done
with active/done dependents are refused without changing either task. Derived
readiness changes do not revise the dependent task.

Unknown-response scenarios forward a genuine status PUT and confirm its commit
before dropping the browser response. GET reconciliation can fail independently;
it never retries the PUT or attributes the observed state to the uncertain write.
Late responses remain with the original resource across navigation. Large int64
version cases retain exact GET/PUT/database digits. Real graph failures preserve
the confirmed detail and restore the owned fixture table afterward. Timing barriers
control response delivery without fabricating status-changing responses. The
[cross-layer decision](../../.agents/notes/implemented/testing/2026-10-22-task-lifecycle-cross-layer-acceptance.md)
distinguishes installed-process races, production journeys and offline fixtures.
The status journeys retain their annotations, target topology, coverage and
cleanup checks. Capacity selection is owned separately by the
[local stress decision](../../.agents/notes/implemented/testing/2026-11-03-local-stress-suites.md).

One packed/installed CLI is shared by the whole web run. On each target,
`task-attachments` uploads through that CLI and consumes the same task/files in
the production page, then checks Web mutations through raw CLI reads. It covers
Markdown relative images, image/text/PDF and interactive HTML resources, detail
tabs and retained attachment state, adjacent panes, scroll-owner geometry, and
standalone opening and reload. Standalone address/history and shared file-operation
checks remain tied to the corresponding source-qualified browser result. PDF acceptance polls compositor screenshots for a substantial fixture-only colored
marker. It measures matching connected components independently and checks the
largest main-page candidate extending into the frame's right half. This
fixture/viewer location rule excludes thumbnail-only paint; independent bounds
also prevent a separate thumbnail from diluting the page marker's density. The
successful PNG and component metrics remain in the marker evidence; HTTP success
or an iframe load cannot satisfy this check. The
[combined acceptance decision](../../.agents/notes/archived/testing/2026-10-21-task-attachment-cross-layer-acceptance.md)
records the original data-sharing, rendering and independent-reading proof choices.

The additional [combined authentication journey](scripts/acceptance/auth-combined.mts)
requires a separate eleven-check receipt on each runtime target, alongside the
64 ordinary Playwright cases or 69 cases in local stress mode. It reuses the same installed package and normal Alice/Bob
identities, records their initial project sets, and crosses browser and CLI data
through shared/private projects, original-credential service restart, logout/PAT
independence, revocation, admitted upload, real socket interruption and normally
minted PAT expiry. The bilingual token journey holds a real server response and
checks retained pending input and one-time reveal; screenshots follow secret
closure or masking. The runner supplies service-only restart callbacks and the
explicit validated installed-package receipt. Actual staging bytes and metadata
are observed independently of client write completion. The
[authentication acceptance decision](../../.agents/notes/implemented/testing/2026-10-23-authentication-combined-acceptance.md)
owns these mechanisms, failure/cleanup rules and the separate actual-upstream
human login requirement. Implemented checks and source-bound run results remain
distinct; a focused pass or historical baseline does not establish full current
acceptance.

Browser attachment selection uses the shared
[attachment-tree helper](tests/e2e/attachment-tree.ts) to resolve the full relative
path and explicitly open each ancestor before accessing its file or actions.
Both E2E scenarios and CLI/browser combined acceptance follow this rule. Unit
interactions must also open ancestors; a `fireEvent` dispatched to a hidden
jsdom descendant does not prove visible navigation.

Independent reading acceptance supplements the strict pipeline with real-service
probes across desktop, tablet, narrow and short viewports in both languages. It
checks wheel and keyboard access to the document end, fitting-content overflow,
left/right independence, and ordinary standalone focus behavior. Native PDF
input reaches the actual viewer through keyboard navigation; real wheel and
Home/PageDown/End input plus the unique painted final-page footer establish
usable reading. Private viewer DOM is used only for read-only offset diagnostics.

Failure probes hold request timing while an owned metadata-table failure or an
unavailable stored file produces actual service errors. Partial-list failure
remains incomplete, preview 404 remains a visible error, and upload failure
retains the busy/form lifecycle before retry. Missing-file recovery, delayed
responses and unchanged task/graph state remain explicit checks. Restored faults
and all owned browser, service, database and storage resources require confirmed
cleanup. First-party fixture checks remain distinct from source-bound probes. The probe's local browser identity
is recorded and is not a hosted-CI browser claim.

The explicit local browser stress matrix retains the complete capacity fixtures,
five repetitions and fixed latency budgets. Its chain, merge and external
fixtures create independent tasks in their
source-first batches, then attach dependencies with versioned PATCH requests
from sinks toward sources. Merge and external attach one complete layer at a
time, with at most six requests within that layer; predecessors have no upstream
dependencies when cycle validation visits them. Each PATCH-returned task replaces
its earlier version, including the merge limit probe and the external sink before
its dependency classification. Shared-root construction retains its direct API
writes. Complete snapshots compare every node and dependency with the fixture;
the actual API order remains the overview oracle's input. The [fixture
construction decision](../../.agents/notes/implemented/testing/2026-10-28-web-capacity-fixture-construction.md)
records the additional API-write cost and the retained acceptance boundaries.

Capacity keeps four exact complete API inputs: 1,000 tasks each, a 999-edge chain
and 5,000-edge merge/shared/external graphs. Complete snapshots still compare
every task and dependency. Browser readiness now checks bounded overview S and
all real induced visible edges, followed by explicit expansion/reset and exact
counts; it no longer requires every input task/edge in the DOM simultaneously.

Inspection acceptance retains five samples and all mandatory
visibility rows, adding selectedId/hiddenUpstream and selectMs≤300. open≤3000 and
detail/zoom/pan≤300 remain. Normal Details→close→immediate zoom/pan precedes trusted
visible-task selection and the highlighted sequence; each metric uses the worse
state with independent network timing, and no close-to-zoom reset/fit/wait.
Independent API/P/S topology derives compact/expandable heights from hidden direct
neighbors inside P; unrelated outside-P successors cannot create a footer.
Actual DOM fixed ports, cubic tangency in the selected direction, card avoidance,
body/marker coverage and independently integrated curved dash phase cover every visible edge.
Stable owner transforms are graph-relative real root/owner CTMs; raw screen,
page-scroll and canvas diagnostics stay separate from reset equality.
The `task-agent-permission` journey on both targets covers member-authorized
permission changes, both confirmations, cancellation/Escape, in-progress
locking, exact versions, conflicts, actual writes with lost responses and read
recovery, close/reopen ownership, bilingual narrow layouts and task-local
list/node indicators. Only registered permission PATCHes and exact request
counts are permitted; unknown writes are not replayed. The `task-platform`
journey covers status-row selection and confirmation, zero-write cancellation
with select-focus restoration, explicit set/clear, shared mutation locks,
conflicts, unknown-result readback, late-response ownership and bilingual
320px/390px layouts through the real service.

Platform-review helpers wait for an enabled select, focus it and verify that
focus before choosing an option. Cached details can appear while the live read
still disables editing; option selection's later actionability wait does not
repair a focus attempt on a disabled control. The cancellation assertions still
require the saved value, restored select focus and zero writes, without forcing
focus after dismissal or increasing timeouts. Attachment component checks wait
for actual preview focus after delete-dialog teardown while its list reload is
still pending, then release the reload and require focus to remain. The
[observable-readiness decision](../../.agents/notes/archived/testing/2026-10-20-observable-acceptance-readiness.md)
records the synchronization rule.

The `task-detail-page` journey observes source and popup requests at the browser
context boundary. Only one registered task may receive exactly five PATCHes
(platform success, permission enable, platform conflict, deliberate platform
retry and committed response loss) and three PUT `/status` requests for
todo → in_progress → done → todo. Version increments, start/finish/reset timing,
and running-state permission/platform locks are checked. One exact attachment
URL permits one PUT and one DELETE. Cancellation adds no write;
uncertain outcomes reconcile by GET without PATCH replay. The source page itself
has no mutation allowance. A separate anonymous context exercises real
login-return redirects while only the provider endpoint is controlled, with
zero application mutations. Complete content/actions, modal-local navigation,
task/tab/file history, retained state and bilingual desktop/narrow/short layouts
are checked in both runtime targets.

The selected inventory (64 ordinary cases; local stress adds five native cases
for 37 native / 32 container, 69 total), current manual/periodic refresh,
attachment tabs/standalone reader, bilingual/auth boundaries, zero retries, timeouts,
coverage, size refusals and cleanup remain. PR #143 delivered dependency inspection;
its receipts bind results to that exact tested source. The authentication/lifecycle
merge requires its own complete receipts.

The [graph functional scenarios](tests/e2e/workflow.spec.ts),
[attachment journey](tests/e2e/attachments.spec.ts),
[Markdown description journey](tests/e2e/markdown.spec.ts),
[language journeys](tests/e2e/i18n.spec.ts),
[authentication journeys](tests/e2e/auth.spec.ts),
[status journeys](tests/e2e/status.spec.ts),
[permission journey](tests/e2e/task-agent-permission.spec.ts),
[pause journey](tests/e2e/task-pause.spec.ts),
[platform journey](tests/e2e/task-platform.spec.ts),
[standalone-detail journey](tests/e2e/task-detail-page.spec.ts),
[project-settings journey](tests/e2e/project-settings.spec.ts),
[execution-time journey](tests/e2e/task-execution-time.spec.ts),
[capacity scenarios](tests/e2e/capacity.spec.ts) and
[acceptance runner](scripts/acceptance.mts) map to the
[Web requirements](../../docs/spec/daynight-web.md) and
[language requirements](../../docs/spec/daynight-web-i18n.md) and
[execution-timing requirements](../../docs/spec/daynight-task-timing.md) as follows. Names are stable
scenario annotations validated in each target's report. `capacity-*` annotations
belong only to explicit local browser stress acceptance; ordinary CI validates
the remaining functional scenarios.

| Requirement | Production checks |
|---|---|
| W1 | `project-list`: more than 50 projects, cursor requests, unique cards and navigation to a later-page project |
| W2 | `project-graph`, `deep-links`, `task-attachments`, `task-detail-page`: project entry, direct HTML reload, complete standalone task/tab/file navigation and history without source-tab state; modal selection remains local |
| W3–W4 | `project-graph`, `project-view-tabs`, `refresh-staleness`, `failure-recovery`: Overview default without a saved preference, per-project outer-section restoration on reload and return, responsive section navigation, exact statistics, retained task-list subtree and closed graph dialog across outer round trips, isolated Overview/task scroll and no extra synchronization, ordinary-component categories and member progress, direct standalone details, independent completion filters, per-project inner-tab/shared task-list scroll restoration, category switches without programmatic scrolling, natural short-content clamping and temporary graph-dialog opening, dependency reclassification and consistent full refresh |
| W5–W7 | `project-graph`, `keyboard-focus`, `capacity-chain`, `capacity-merge`, `capacity-shared`, `capacity-external`: Goal disclosure with complete unique child rows and direct task details, independent explicit 80% graph dialog and narrow-screen gutters, list/focus/scroll restoration, complete projection data, bounded overview/induced edges, explicit expansion/reset, state markers and detail/viewport actions |
| W8, TI12–TI14 | `detail-navigation`, `refresh-staleness`, `task-detail-page`: shared complete dialog/page content and actions, title-bar/attachment popouts, task/tab/file history, query-preserving login, nested confirmations, precise/conflicting/unknown writes, automatic full-detail reads and retained geometry/state |
| W9 | `refresh-staleness`, `failure-recovery`, `deep-links`, `capacity-limits`: periodic status updates and automatic recovery, owned-database failure/restoration, cached content with correlated refresh errors across reload, cold-cache initial failure/loading, empty/not-found states, cached project navigation during delayed sync with request cancellation, and complete size refusal |
| W10 | Native and container functional targets, exact image identity and dev-ci cleanup receipt |
| W11 | Strict raw Go/V8 coverage reports, validated functional browser receipts and the final `checks` result; explicit local stress mode additionally validates complete performance receipts |
| W12, TI6–TI7, TI16 | `detail-navigation`, `keyboard-focus`, `narrow-layout`, `project-view-tabs`, `refresh-staleness`, `task-attachments`: normal and fullscreen dialog/page geometry at desktop/320px/390px and short heights, independent scrolling and persistent controls; graph/standalone entry, layered detail/graph Escape, trigger disappearance, inert/scroll release, retained Surface/frame/input/session identity and same-origin frame owner changes |
| W13 | `task-status`, `task-status-conflicts`, `task-status-recovery`, `task-status-transitions`: same-data packed-CLI/ordinary-graph lifecycle, three-state transitions, direct completion, reopening and same-state no-op, metadata/attachment preservation, status menu and permission confirmations and tabs, cancel/Escape/focus, invalidation, stale CLI metadata, CLI/Web same-version competition, pending protection, exact int64 digits, real-commit response loss, real graph failure and task/SPA-project identity/focus/browsing preservation |
| W20 | `task-assignment`, `task-assignment-layout`: native field propagation, real exact-version assignment/clear PATCHes, same-value zero writes, conflict and committed-response-loss GET-only recovery, people identity/access presentation, local filters with full-chain facts, bilingual desktop/narrow menu, focus, scroll and fullscreen behavior |
| W21 | `task-pause`: project/list/chain/graph pause discovery, complete-scope counts, common heading and Unpause, exact-version property PATCH with preserved task materials, duplicate protection, conflict and committed-response-loss GET-only recovery, bilingual narrow layouts |
| W15 | `task-platform`: status-row selection and confirmation, zero-write dismissal and select-focus restoration, set/clear, shared status/permission gate, exact versions, stale/unknown GET-only recovery, cross-task late ownership, manual-start lock, field propagation and bilingual narrow layouts |
| TT3 | `project-settings`: real-service direct entry/reload, administrator save and independent member read, project isolation, exact settings versions above 2^53, stale conflict and demotion, read-only member recovery, actual commit with lost response and failed-read retry without PATCH replay, bilingual 320px/390px form/control/navigation containment and unclipped text |
| TT1–TT2, TT4–TT6 | `task-execution-time`: real PostgreSQL crossing with graph deliveries held and an incorrect client wall clock, one-second local progress, stable focus/DOM/geometry/edges/viewport, real saved-threshold changes, installed-CLI completion and frozen polling, unknown legacy starts, sub-minute/multi-day/shared/external cards and standalone rows, bilingual 320px/390px layout; browser GET/HEAD only, with fixture mutations through authenticated API or installed CLI |
| FA1–FA12 | `task-attachments`: installed CLI and production UI share real task/files on native and container targets; exact bytes, file mutations, detail tabs, shared full attachment panel, unique preview scroll owners, rendered formats, standalone address/history and embedded-local selection. Independent real-service probes add end-of-document wheel/keyboard, native PDF final-page paint, fault/retry and unchanged task/graph proof |
| TI8–TI9, TI15 | `task-description-markdown`: installed CLI and real API preserve Unicode/CRLF Markdown bytes and versioned full replacement; bilingual 1440px/320px rich rendering, escaped HTML, URL policy, task-root images/encoded references, paginated loading/list failure/retry, invalid/missing/preview failure states, one-controller navigation/focus, overwrite refresh, modified native href and HTML frame interaction; TD/LR/Chinese flowcharts, independent failures/source, static image safety, content switches and standalone reload share the three Markdown entries; inspection→Details→relative attachment→close preserves graph selection/geometry/view |
| TP-V1, TP-V7, TP-V8 | `detail-navigation`, `refresh-staleness`, `keyboard-focus`, `narrow-layout`: real API round trips for empty/NUL/control/long/HTML-looking values and duplicates, complete locally paged lists with bounded row counts, page/collection reset and focus, plain-text unsafe addresses, isolated HTTP(S) navigation, rereading properties and compact graph responses |
| L1–L4 | `language-startup-preferences`: browser default, saved override, reload, route metadata, shared selectors and unchanged user data |
| L2, L4–L5 | `language-state-preservation`: graph geometry/viewport, fullscreen and modal focus, PR page, file input and iframe identity; pending upload, overwrite and deletion execute once |
| L3–L4, L6–L8 | `language-errors-and-narrow`: storage failures/retry, owned-database failure with current-language safe text and unchanged request ID, English/Chinese 1440px/320px graph/dialog/attachment layout |
| L9–L10 | Task-attached offline mockup checks, typed catalog/component checks, and complete native/container production receipts with the existing coverage and cleanup gates |
| Authentication | `auth-login-session`, `auth-project-isolation`, `auth-project-members`, `auth-personal-tokens`, `auth-invitations`, `auth-resource-session`: normal login/logout, private project access, roles and removal, PAT creation/revocation, explicit invitation acceptance, protected files and resource-session loss |

Receipts live in `packages/daynight-web/.tmp/acceptance/<run-id>/`, with the
latest aggregate at `.tmp/acceptance/evidence.json` inside this package. They
use top-level `schemaVersion: 3` and record source identity, including required
`source.gitTreeSha` from actual `git rev-parse HEAD^{tree}`, the installed CLI
receipt and raw artifact identities, native binary
SHA-256, PostgreSQL/browser versions, `mode: functional` or `mode: stress`, pipeline
stages, target phases, container image identity and cleanup outcomes. Stress
mode additionally records capacity measurements. Each stage records
its result, start/end times, observed command process identities and spawned
process groups. Each browser phase records its own result, browser identity,
Playwright process/group and `browserCleanup` result. Raw reports and screenshots
live under `native/functional/` and `container/`; stress runs additionally create
`native/capacity/` and its unchanged schema 1 `performance.json` receipt.
Local ordinary/stress runs and CI shard 2 require
`native/auth-combined/target.json` and `container/auth-combined/target.json`, both
schema 1 with `kind: auth-combined`. They require all eleven canonical checks,
source/browser/installed-package identity, old/new restart process identity and
passed browser/resource cleanup. Shard 1 has no combined-authentication receipts.
They retain safe observations and hashes, not credential/configuration bodies
or raw logs.

Schema 3 functional `evidence.json` includes `shard: { current, total: 2 }` and
`selection: string[]` for CI shards. Each native/container target and functional
phase must match that selection. The final validator requires the two selections
to be disjoint and cover the canonical inventory exactly once per target, with
all 22 combined checks assigned to shard 2. Local unsharded receipts keep their
complete inventory without shard metadata. `CI` requires a clean checkout
matching `GITHUB_SHA` and the pinned browser. Each database uses one worker and
zero retries; skipped, flaky, duplicate/missing or incomplete scenarios fail.

Full shard artifacts are `daynight-web-acceptance-1` and
`daynight-web-acceptance-2`, separate from raw coverage and retained for 30 days.
Inspect the artifact from the exact workflow run and tested checkout identity,
which is normally a merge revision for PR runs. Complete ordinary validation
requires thirty-two native and thirty-two container functional scenarios across
the two CI shards or in one local run. Explicit local stress requires their
strict native union with five capacity/limit scenarios and the same thirty-two
container scenarios. Every selected phase rejects missing, extra or duplicate
scenarios and skipped/flaky/retried results.
Installed-CLI handoff, container callbacks and recovery require matching source
commit/tree/dirty state as well as existing package/artifact ownership. A missing
or mismatched tree field fails; no old-receipt fallback is introduced. The tree
identifies committed source and does not fingerprint local modifications or prove
an executed platform/gate. Lifecycle attachments to each status scenario retain
CLI arguments/outputs/exits, raw-byte digests, task/graph snapshots, captured Web
requests/responses and declared controlled faults under the same run identity.
Browser identities must agree across a target's phases. In local stress mode,
every fixed graph's five timing repetitions and independent size refusals must
pass. Cleanup and recovery remain required in both modes.
Local receipts retain their source and browser identity; they do not establish
clean hosted delivery results. The
[paint decision](../../.agents/notes/archived/bug-fix/2026-10-20-long-dashed-dependency-paint.md)
retains raster evidence and visual tolerances needed to assess that mechanism.

Functional `playwright.json` reports retain named body steps for attachment
fixture uploads, preview/deletion matrices, task-page reading layouts and
execution-time synchronization. Compare each test's total with its sibling step
durations; a parent duration already includes its nested steps. The remaining time includes
fixture/authentication setup, unwrapped actions, screenshots outside the named
blocks and teardown; it is not pure fixture time. The pinned JSON reporter omits
steps nested under fixture hooks. These wall-time observations do not alter
assertions, deadlines or acceptance thresholds and do not establish CPU or I/O
causality. The [journey timing decision](../../.agents/notes/implemented/testing/2026-11-04-web-journey-timing.md)
records the reporting and privacy limits.

Capacity receipts also retain per-interaction `feedbackDiagnostics`: input,
capture, first ready condition, first/second frame and final end timestamps,
status/error and phase differences. Missing milestones stay null. Each repetition
attaches `*-chromium-trace.json` from CDP timeline/frame/GC/User Timing events,
without CPU sampling or CDP screenshots. These diagnostics preserve all original
total timing/readiness gates; they do not subtract queue/frame time or turn a
failed measurement into success. Scenario PNG evidence remains independent.
All production browser tests disable Playwright action/network traces to keep
session Cookies, PATs and invitation contents out of published artifacts. The
[activation decision](../../.agents/notes/implemented/architecture/2026-10-22-authentication-activation.md)
owns that privacy requirement. The custom streamed CDP traces, scenario PNGs and
complete graph/geometry checks remain. Controller-side
`controllerDurations` records fixture creation, graph snapshot validation and
per-repetition interaction/total durations. These diagnostics locate harness
costs outside the browser input-to-feedback gates; they do not alter those gates.
The [CI efficiency decision](../../.agents/notes/archived/testing/2026-10-21-ci-validation-efficiency.md)
records why this avoids duplicate capture work without splitting the suite.

### Cleanup and interrupted-run recovery

Combined browser and command recovery includes both `native/auth-combined/` and
`container/auth-combined/` alongside the existing phase directories. The runner
retains the same service origin, UniAuth, PostgreSQL and file root during each
service-only restart, and verifies original credentials before intentional
logout, revocation or expiry.

The runner registers owned-resource cleanup before creating its database or
native process. Timeouts and cancellation stop owned command groups; browser
receipts identify the detached Chromium group and project-local profile as well.
A passing run requires confirmed native, browser/profile and dev-ci cleanup.
Each phase verifies its Playwright group has stopped and recovers owned browser
resources immediately. Profile roots are derived from the validated phase
location under `acceptance-private/<run>/`, outside the uploaded acceptance
artifacts. Playwright allocates profiles there; Chromium keeps the short relative
`.tmp` directory for Unix sockets so the private path does not exceed socket
path limits. Inventory and recovery inspect only that phase's root, preserving
unknown-startup and process-identity failures without touching another target.
After native preparation, an atomically written
`container/container-permission.json` binds completed preparation to the exact
acceptance run ID, dev-ci run ID and source SHA. The container callback records
its identity before waiting, and inventories browsers only after permission;
its `ready.json` is diagnostic timing, not browser permission. Both functional
targets drain before run-wide CLI recovery and optional local capacity. Any stage
failure or unexpected native-server exit cancels sibling work, drains started
tasks and preserves failures before unconditional final cleanup.

After the original runner, callback/Playwright processes and their owned groups
have stopped, run
from the repository root:

```bash
node packages/daynight-web/scripts/acceptance.mts --cleanup
# Select a retained run instead of the latest receipt:
node packages/daynight-web/scripts/acceptance.mts --cleanup RUN_ID
```

No receipt is a no-op. Recovery accepts only top-level schema 3 receipts;
schema 1, schema 2 and unknown versions fail without a compatibility fallback. Valid
receipts constrain recovery to recorded run/source identities, exact Docker labels and names, and host platform/PID/executable/start-time
identity. Linux uses procfs ticks; macOS uses kernel start time in microseconds,
actual executable paths and process groups. Receipts from another platform are rejected. It verifies recorded stage command identities/groups and visits browser
recorded phases in reverse order: optional `native/capacity`, then `container`
and `native/functional`.
A still-running native Go process also requires its recorded binary
hash before targeted termination. Browser recovery checks its recorded executable,
process group and profile marker; ambiguous startup processes, orphan-only groups
or unknown new profiles cause failure and remain for diagnosis. It does not kill
unidentified processes or remove unidentified profiles. Dev-ci recovery uses the
same recorded project identity and bounded cleanup entry.

The runner persists one `installedCli` ownership record before package
preparation: its deterministic `<acceptanceRun>/installed-cli` root and cleanup
state exist even if a completed receipt does not. Preparation creates that root
exclusively. Cleanup requires recorded commands/groups to have stopped, validates
completed artifacts when present, removes only that root and persists its cleanup
state in the original evidence before later native/Docker cleanup. Recovery can
repeat after interrupted preparation or a subsequent cleanup failure; a live
preparation process blocks removal.

After verifying owned installed-CLI members and sending SIGTERM, recovery waits
for both an empty owned-member scan and ESRCH from `kill(-PGID, 0)` on the original
group. It uses the existing two phases of fifty 100ms polls; an exited but unreaped
group cannot satisfy cleanup merely because `/proc` ownership or executable data
has disappeared. Remaining members require unchanged identities before SIGKILL.
An initially live group without verified owned members fails immediately, and
EPERM or other probe errors remain failures. The
[pipeline decision](../../.agents/notes/archived/testing/2026-10-21-web-acceptance-pipeline.md)
owns the recovery rationale and real-kernel reproduction.

Recovery writes separate per-run/latest `recovery.json` receipts and preserves
the original acceptance outcome while retaining completed cleanup state. A successful recovery does not turn a failed
browser or performance result into acceptance. The CI `always()` recovery step
and artifact upload retain this distinction; cleanup uncertainty fails the job.

## Dependency declarations

Dagre is pinned to 3.1.1 with a runtime pnpm patch for its public ESM and CJS
entries. The adapter uses one global longest-path ranker, preserving default
crossing minimization and alignment. The patch skips an empty flat-graph border
conflict scan and indexes equal truthy barycenters while preserving original
scan/tie/removal order. Exact differential geometry checks compare patched and
unpatched code under that same ranker policy. `scripts/dagre.test.mts`, included in `web:test`, reverses the committed patch
in memory and checks pristine published bundle hashes before comparing 23
fixtures across four directions and three rankers in both formats. Direct
barycenter/tie/removal assertions and license/source-map checks supplement exact
coordinate, edge-point, bounds and determinism comparisons. Upgrades must rerun
these regressions. Longest-path can lengthen edges and normalization depends on rank
spans; fixed capacity timings do not promise the same latency for arbitrary DAGs.
The [layout decision](../../.agents/notes/archived/feature/2026-10-20-task-graph-projection.md)
owns those trade-offs.

React Flow is pinned to 12.12.0. Its system dependency 0.0.83 has a declaration-only
pnpm patch in the root `patches/` directory, referenced by the workspace and lockfile.
The patch restates a mapped generic's NodeBase constraint; it changes no runtime
bundle and leaves exact optional checking and library checks enabled. Type-only
assertions in `tests/xyflow-types.ts` protect custom fields and reject explicit
undefined positions. Frozen installs and container builds must include the patch.

## Boundaries

API errors expose fixed safe text and a validated request ID; raw response bodies
and server diagnostics do not reach the page. Project names and addresses render
as text. The API parser verifies DTO shape and resource identity. The implemented graph
model separately verifies dependency closure, acyclicity, status/readiness and
summary consistency. It projects root descendants plus their complete ancestor
closure, excluding unrelated descendants of contextual tasks. `mainIds` retains
chain membership; `externalIds` identifies additional ancestors. Complete projection P retains every required dependency. Visibility selects
S and all real edges with both endpoints in S; external classification still
depends on source membership in P−M. It derives distinct root progress and aggregate chain status from main
tasks in the same traversal, and marks shared tasks. The Dagre
adapter returns finite left-to-right or top-to-bottom node positions and routed edge points for
220px-wide visible cards with 96px compact or 136px expandable heights. The
read-only React Flow canvas consumes these results without changing domain
objects. React Flow owns task nodes with those exact dimensions, native ResizeObserver measurement,
keyboard behavior, viewport and controls. One memoized SVG in its public
ViewportPortal renders every planned M/L/C path, with stable edge identity,
arrowheads, external-context dashes and accessibility semantics. It shares the viewport's
transform, so selection/pan/zoom reuse geometry without per-edge reactive state.
Canonical routes retain native arrow markers and the full planned geometry.
Passages use cubic Bézier curves entirely within empty rank gaps, with controls on the gap midpoint at the respective endpoint cross-axis coordinates. Tangents follow the selected direction and join free passages through intermediate ranks, which retain sixteen units of clearance from cards. The
[Bézier routing decision](../../.agents/notes/implemented/architecture/2026-10-25-bezier-task-dependency-routing.md)
owns the shape and avoidance mechanism. Dashed body paint uses `routes.ts` to
derive locally rotated lines and exact cubic subcurves, with the
original 5/4 pattern and continuous positive arc-length phase. Every paint piece
has at most 8,192 graph units of arc length; internal cuts fall at global dash-gap
midpoints to bound GPU work without removing route geometry. Cumulative phase
error stays within 0.025 CSS px at maximum 1.8 zoom. Solid bodies remain native.
Pieces are noninteractive and hidden from the accessibility tree; canonical edges
keep their existing identity/semantics. The
[paint decision](../../.agents/notes/archived/bug-fix/2026-10-20-long-dashed-dependency-paint.md)
owns the pinned raster evidence and local-line rationale; the
[bounded-line extension](../../.agents/notes/implemented/bug-fix/2026-10-22-bounded-dashed-dependency-lines.md)
owns the original GPU stroke bound and its added DOM cost.
Initial placement uses current visible layout bounds after the viewport and positive
measured canvas dimensions are ready, fitting within 0.8–1 zoom or anchoring the
leftmost rank at 0.8 zoom. The root remains vertically centered when already
leftmost; otherwise the topmost upstream node starts at a 32px canvas inset.
Dependency geometry does not require connection-port DOM or per-edge endpoint readiness.
Graph-local inspection Context supplies presentation roles while controlled node
geometry/data and memoized content retain stable references. Memoized chain rows retain stable props while graph inspection and details change
inside the separately mounted dialog. Changed snapshot indexes
refresh all rows; equivalent graph responses retain the existing index. The one-time initial viewport policy is separate
from explicit fit controls and does not run again on selection or pan.

Page hooks own requests and cancellation. Navigation or refresh invalidates the
previous request generation, continuation failures preserve loaded cards, and
unmount aborts owned work. Attachments have independent scoped list, write and
preview state, while project statistics continue to use complete graph snapshots. The
project hook owns its visible-page timer; navigation and unmount clear the timer
and cancel owned reads. Automatic graph reads never overlap, and same-task detail
refreshes coalesce an in-flight follow-up. There is no global task cache or
task-field editor. Push subscriptions remain deferred; they can trigger the same
complete-snapshot refresh without changing graph projection. Production
`AuthenticatedApp` owns identity loading, authentication and account/membership
flows under the persistent locale Provider. New identities discard user-owned
requests and content; project 404 and discovery failures retain their distinct
resource and provider meanings.
