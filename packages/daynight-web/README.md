# daynight-web

The private React/TypeScript workspace implements project browsing, cursor
pagination, request cancellation, runtime API decoding, native browser routing
and a pure dependency graph model with horizontal layout. Project task views
use an IndexedDB summary cache and the authenticated task-sync endpoint.
The project dashboard, task canvas and task detail dialog are embedded into the Go
server for single-origin delivery. The [localhost deployment](../../deployment/localhost/README.md)
starts the full UI/API/database stack; [dev-ci](../../deployment/dev-ci/README.md)
provides an isolated instance of the same production build.

The [requirements](../../docs/spec/daynight-web.md) own visible behavior and the
[architecture](../../docs/design/daynight-web.md) owns graph projection, request
lifecycles and delivery. The [task property requirements](../../docs/spec/daynight-task-properties.md)
and [design](../../docs/design/daynight-task-properties.md) own PR associations.
The [attachment requirements](../../docs/spec/daynight-task-attachments.md),
[architecture](../../docs/design/daynight-task-attachments.md) and
[Web decision](../../.agents/notes/implemented/feature/2026-10-21-task-attachment-web.md)
own single-file management, previews and their independent state. The original
offline dashboard mockups remain separate from the application; the attachment
development mockup below reuses the real components with a frontend-only fixture.

The [authentication requirements](../../docs/spec/daynight-auth.md) and
[architecture](../../docs/design/daynight-auth.md) define login, private
projects, member and invitation management, and personal access tokens. The
`AuthenticatedApp` implements their browser components and API client. Production
`main.tsx` renders it under the persistent `LocaleProvider`; every business API
requires a browser session or PAT and current project membership. The Go service
retains loopback-only listening. Trusted same-origin previews, relative resources
and keyboard behavior remain unchanged.
The [Web workspace decision](../../.agents/notes/implemented/feature/2026-10-22-web-auth-workspace.md)
owns the frontend lifecycle choices; the
[activation decision](../../.agents/notes/implemented/architecture/2026-10-22-authentication-activation.md)
owns production composition and credential-private acceptance.

## Authenticated workspace

`AuthenticatedApp` runs under the same `LocaleProvider` as the existing
workspace and owns current-user loading, login navigation and session loss. Both
complete catalogs provide its `messages.auth` domain, including accessible names,
validation, notices and already displayed errors. Login, workspace, invitation
and management dialogs expose the shared language selector; native formatters
render dates and counts. Language changes retain form inputs, dialog and
one-time secrets, identity and pending requests without restarting operations.
It composes the existing project list, graph and shared task-detail surfaces with
private project creation, account/token pages, member/invitation management,
project execution-warning settings and explicit invitation acceptance. Task
details expose the versioned automatic-execution permission: one bilingual
label and switch on the right of the status row below the title, with status
and readiness on the left. Both enabling and disabling require confirmation;
Cancel, close and Escape submit nothing. The switch keeps confirmed server
state until success and actual changes are disabled during `in_progress`.
Successful permission changes observed in the open detail show a floating status
bubble for three seconds without moving the heading, tabs or reading area.
Pending, refusal, unknown-result, reconciliation and locked feedback retain their
existing behavior. Dismissing a bubble changes only presentation; reopening a
detail with an already confirmed result does not replay it.
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
freshness, request ownership and unknown-result GET reconciliation. The left
group may wrap the compact control without moving automatic execution from the
first status line's right edge.
`TaskDetailSessionProvider` owns detail, status, permission and platform
state within the authenticated branch, keyed by user identity/session generation.
All three mutations share one task write gate and exact-version freshness
checks. Pending or unknown platform results block permission and status writes;
conflicts require a fresh observation and unknown results require an actual task
read before another write. Close/reopen and navigation preserve the original
request owner, so late responses cannot change another task. Platform updates
preserve status, permission, dependencies, properties and execution times.
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

With `pnpm web:dev`, open `/tests/mockups/auth.html` for actual components with
controlled fetch responses, the same locale Provider and final styles. This fixture validates frontend
interaction separately from real UniAuth service and upstream-provider login. The [static design prototype](../../docs/design/mockups/auth/index.html)
retains the broader scenario reference.

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

Project resources include required `settings.version` and
`settings.executionWarningMinutes`. `project-json.ts` uses shared raw JSON
source spans to decode only root Project settings, each project-page item, or
the graph Project envelope. The existing generic root-version decoder and
unknown nested-field semantics remain intact; no browser reviver source-context
feature is required. Versions above 2^53 remain exact bigint values and mutation
encoding sends JSON numbers. Missing contract fields do not acquire defaults.

Project synchronization merges intrinsic summaries by ID and exact business
version in the current durable collection, then derives task readiness,
statistics and GraphIndex. Duplicate summaries retain task and index references;
settings-only changes replace Project metadata while preserving task projection.
Clock-only responses retain the graph and index while refreshing the separate
latest `GraphSnapshot.observedAt` and its paired `receivedMonotonic`. No settings
edit changes task time or graph geometry.

## Persistent task summaries

`TaskCacheProvider` wraps every authenticated route outside the shared detail
session. Its scope follows the user and session generation, including standalone
task and attachment routes. The origin-local `daynight-task-cache` database uses
schema 1 and idb 8.0.4, with `userScopes`, `projects`, `summaries` and `details`
stores. User fences, project generations and validated manifests guard late
responses and cross-tab transactions. The details store and guarded transaction
interface are shared infrastructure; intrinsic detail content, LRU and
change-driven detail GETs are not connected yet.

`beginSync` reads the epoch and greatest exact accepted summary `updatedAt`;
`applySync` validates the transaction's complete durable set and atomically saves
changed summaries with that watermark. Only project-sync summaries advance it.
Details, mutations, request time, Project time and `observedAt` cannot establish
project coverage. UTC seconds plus nine fractional digits preserve ordering;
business versions remain bigint. The default ten-second server overlap can
repeat its final rows indefinitely, and old/equal rows do not rewrite storage,
invalidate detail records, replace published indexes or broadcast.

The current mount requires its own successful online project sync before private
cache publication. `Daynight-User-ID` is checked before decoding or acting on a
sync response. A verified different principal synchronously releases old content
and starts identity verification. Headerless or malformed-principal errors retain
valid cached content; only a verified same-user `404 not_found` invalidates the
project. Scope invalidation aborts current work and releases memory before its
user-specific persistent purge; ordinary disposal closes resources and preserves
the durable base. Foreground request gating also covers local reads/publication.

Broadcast hints contain no task content or authority. Authorized receivers read
committed stores without issuing another network request. Failed IDB opening,
blocked upgrades, abnormal close, corruption or writes use existing visible
error/Retry states and retain an allowed current view. There is no silent
network-only fallback. `Task sync` diagnostics report cycle/project IDs,
received/changed/duplicate counts, cache hit and apply duration; duplicate includes
ignored old versions. Failure diagnostics expose categories without task bodies
or credentials. The [cache architecture](../../docs/design/daynight-task-sync.md)
owns the algorithm, schema, failure rules and remaining detail integration.

## Task execution time and possible stalls

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

Task cards and standalone rows show live elapsed or frozen completed duration.
Unknown starts show no inferred duration. An exact millisecond comparison strictly
above saved minutes adds amber treatment, icon and Possibly stuck / 可能卡住了
while retaining the running status; completion removes that warning. Localized
text distinguishes less than one minute and uses floored day/hour/minute units
without changing comparison. Semantic `time`, its title and `aria-describedby`
provide exact endpoints, elapsed duration and saved threshold. Button names stay
stable across ticks, and no live region announces every update.

The renderer preserves 220×96/136 cards, independent Details/inspection/expansion
controls, external context borders and selected/prerequisite
outlines. A 42px bottom reserve keeps English Details clear of elapsed text.
Standalone visual timing is excluded from button-name calculation while its
accessible description retains the warning meaning. Chain headers never claim
an individual task's duration as aggregate execution time.

While membership loads, the project heading reserves complete action geometry,
including localized links and the wider administrator badge. Its inaccessible
placeholder is replaced by authorized actions without narrowing the title or
moving the restored page position. The
[header-layout decision](../../.agents/notes/implemented/bug-fix/2026-10-23-project-header-layout-shift.md)
owns that geometry; the existing
[task-view decision](../../.agents/notes/implemented/feature/2026-10-22-project-task-views.md)
owns per-project/tab scroll preferences independently from graph viewports.

## Languages

The [language requirements](../../docs/spec/daynight-web-i18n.md) define the
implemented English and Simplified Chinese interface. The
[language design](../../docs/design/daynight-web-i18n.md) owns typed catalogs,
cached native Intl formatters, initial resolution, a Provider and the shared
native selector under `src/i18n/`. Production `main.tsx` resolves language and
sets HTML `lang` and the authentication loading title before React renders.
`AuthenticatedApp` and the workspace update document
metadata on navigation and language changes. The top bar and fullscreen graph
expose selectors using the same saved language. Task details consume the current
application locale through the same Provider; their header contains the task
title, current status menu and close control.

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

With `pnpm web:dev`, open `/tests/mockups/locale-runtime.html` for the
[actual-component runtime preview](tests/mockups/locale-runtime.html). It shows
shared selectors and retained fixture state with production selector styles
and no Go API or PostgreSQL. The actual-component
[browsing](tests/mockups/browsing.html) and
[attachment](tests/mockups/attachments.html) previews also mount the Provider
explicitly. Fixtures verify frontend behavior;
production claims require real service receipts. Web typecheck, test and build
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
path through the same Go API target. When unset, no callback proxy is added and
frontend-only mockups remain independent of the Go service. The five required
backend authentication settings and explicit HTTP test policy follow the
[deployment guide](../../deployment/localhost/README.md); changing the browser
origin does not relax callback or Cookie-write Origin checks.

The project list requests 50 items per page, preserves
server order, and follows `nextCursor` through Load more. Repeated IDs count once.
Refresh discards old pages and cursors; late responses cannot repopulate them.

The application implements `/`, `/projects/{projectId}`, `/account`,
`/invitations` and the standalone
`/projects/{projectId}/tasks/{taskId}/attachments/{path...}` reader, direct URL
reload, browser back/forward and a generic not-found page. All resource reads use
the current authenticated identity. A project shows six statistics from one
complete graph snapshot and two in-project tabs: Standalone tasks and Task chains.
The first visit opens Task chains; subsequent visits restore the project's last
tab. Both tab badges count unfinished tasks (pending and in progress)
from the complete snapshot, independently of completed-item visibility, active
category and expanded chain. Their sum equals the project's unfinished total;
toolbars separately report visible/total entries.

Chain membership is an ordinary-edge weak component: `dependsOn` contains all
prerequisites, while `externalDependsOn` marks edges that do not join components.
A normal `A → C ← B` creates one chain with two starting tasks and one member set. A chain's representative is its earliest ordinary-root
member in exact service order; its title and creation ordering supply the row.
Singletons with no ordinary incoming or outgoing edge are standalone tasks,
even when external prerequisites block execution. Status and completion filters
do not change membership. All edges still participate in execution consistency
and full prerequisite inspection.

Standalone rows are compact native detail triggers with title, individual
status, ID, creation time, automation permission and known execution timing.
An unfinished prerequisite produces an explicit Blocked / 被阻塞 badge. Chain
rows aggregate only component members: all done means done; otherwise any done
or in-progress member means in progress; otherwise any todo member means pending;
otherwise all members are todo. A completed representative with unfinished
members stays visible. External prerequisite context does not contribute to
chain progress or status. The former shared-membership badge is removed: a task
can recur as context while its actual component membership remains unique.

Each category retains its own completed visibility and scroll position. Chain
ordering uses its representative's exact `(created_at,id)` service order,
reversed for newest first without lossy JavaScript timestamp conversion. Expanded
preferences retain the original task witness in `{expandedRootId}` and resolve
its current component after merges or splits, rather than overwriting it with a
new representative. Explicit null stays collapsed on reload. Existing missing or
hidden-entry fallback and storage-error notices remain. Membership changes
initialize a new bounded overview and framing without remounting a same-representative
fullscreen canvas or active Details. A representative change is a chain switch.
Ordinary status and clock refreshes retain visible S, viewport and inspection
under normal reconciliation.
The [task view decision](../../.agents/notes/implemented/feature/2026-10-22-project-task-views.md)
and [chain status decision](../../.agents/notes/implemented/bug-fix/2026-10-22-task-chain-status.md)
record their current rules and original rationale.

The runtime accepts todo, in_progress and done. The graph summary has six
counts: total, todo, inProgress, done, ready and blocked. They satisfy
`total = todo + inProgress + done` and `todo = ready + blocked`. Creation uses todo.
All-done chains are done; any done or in-progress member makes an unfinished
chain in progress; other chains are todo. External context does not affect progress.

The actual task title is the common dialog header and accessible name; ID/copy
belongs to Overview. The three-item status menu remains available on both tabs,
marks the current item and permits selecting it. Arrow/Home/End, activation and
Escape preserve keyboard access and focus. Confirmation shows the full task name,
current/target states and timing consequences. Cancel is initially focused;
Cancel/close/Escape submits nothing. Long title and confirmation text have bounded
native scrolling; 320px retains controls without horizontal page overflow.

Status, allowAgents and requiredPlatform saves share one per-task mutation owner and confirmation union.
Reviewed identity/status/version and material inputs remain frozen; observed
changes invalidate confirmation. Exact bigint version survives JSON numeric
serialization without rounding. Same-state requires +0; actual change requires +1.
Same-state may return fresh derived readiness at the same version. Generation and
confirmed-version floor prevent older reads from restoring stale state.

Pending, stale, unknown or failed reconciliation blocks all three writes. Closing or
switching details retains original ownership. A confirmed result refreshes the
matching project graph while keeping panels, attachments, reading and focus.
Conflict rereads require fresh review. Unknown results keep the write error and
use GET-only reconciliation; observed state is not attributed to the uncertain
write. Failed reads keep both errors and offer GET retry. A 404 clears unavailable
private content while retaining unknown feedback. Identity replacement disposes
the old session; late responses cannot populate another task or identity.

Permission changes are forbidden during in_progress; automatic discovery requires
allowAgents=true, while explicitly designated execution accepts either value.
Permission success uses a three-second toast; persistent failures and reconciliation
remain accessible. Status does not stop a process, transfer worker ownership or
provide delivery authority. The [status architecture](../../docs/design/daynight-task-status.md)
owns server rules, migration and timing. The [component fixture](tests/mockups/browsing.html)
uses production sessions/styles for frontend behavior; actual service acceptance
separately proves HTTP, database and persistence behavior.

Both lists use newest creation first, with descending IDs breaking equal-time
ties. Presentation reverses the exact API sequence without reducing timestamp
precision; updates do not move older tasks. Completed items are hidden by default
in each category. Each tab has its own completed-count checkbox, visible/total
count and per-project visibility preference. An empty category, hidden all-complete
items and a truly empty project have distinct states. Revealing completed items
focuses the persistent checkbox before the empty-state action disappears. Long
titles grow naturally in compact native row buttons. Chain buttons keep a 62px
minimum height and 7px row gaps; a single-line bordered row is about 64px.
Desktop titles stay 13px and narrow-screen titles 12px, with readable
metadata/status sizes of 11px/10px.

Rows open one horizontal graph at a time. Complete P contains every ordinary
component member and every required ancestor through all dependency kinds,
without unrelated successors of context tasks. Main progress counts component
members only, and project counters count each project task once. Actual visible
S is progressive for members and context alike. Dashed edges encode explicit
external dependencies, including a shortcut inside one ordinary component;
dashed cards encode context outside that component. Ordinary context edges stay
solid. Details labels prerequisites, blockers and successors using each edge's
own marker; no dependency editor is added.

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
InitialViewport frames the new overview. TaskCanvas, ReactFlow and the fullscreen
owner stay mounted, preserving fullscreen, active Details and their inert/scroll
locks. A changed representative is an ordinary chain switch and replaces its
row and graph. Reset computes a new baseline. Ordinary failure retains old
content only in the same identity/project/auth scope; current401 and resource
invalidation still unmount private content. Local S and inspection do not
persist. Locale translates controls without adding business reads. The
[progressive decision](../../.agents/notes/implemented/feature/2026-10-22-progressive-task-graph.md)
separates topology state from presentation lifetime.

Per-project browser preferences retain the selected tab, each tab's page scroll
position and completed-item choice, and the chain's original task witness or
explicit collapse across reloads and navigation. The existing
`{ expandedRootId: string | null }` shape remains: resolve a valid witness to its
current ordinary component, then display that component's representative.
A representative change must not overwrite a still-valid original witness.
First visits open the newest visible chain; missing/hidden witnesses use the
existing visible fallback. No visible chains, loading, failed initial reads or
empty graphs do not invent explicit collapse. Null remains collapsed on reload.
Storage failures leave the current page usable with a visible notice. Both
stable tabpanel wrappers retain their IDs and hide inactive content; returning
to a chain retains the witness while its canvas initializes again. Page scroll
restoration does not persist details, coordinates, zoom or pan. Tab switching,
filtering and scroll restoration make no API requests and do not alter the full
project counters or prerequisite data. The [preference decision](../../.agents/notes/implemented/feature/2026-10-21-task-browsing-preferences.md)
records the persistence rules.

The detail decoder requires `properties.pullRequests` with string `url` and
`title` fields. Missing or malformed structure produces the existing detail
error and retry state. It preserves string content, including NUL and arbitrary
address text, without defaults or content validation. The graph decoder retains
its compact projection and never copies properties into graph nodes.

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

An open project automatically requests task-sync every five seconds while the
document is visible. Hidden documents start no periodic reads; returning requests
immediately unless a sync is already active. Automatic ticks skip active syncs.
Manual refresh cancels the active read and starts immediately. Every successful
response updates the mount's receipt time and current detail read, including
duplicate-only responses; this preserves the current detail-session policy until
persistent detail reuse is connected. `GraphSnapshot.revision` is this successful
mount-local receipt, not a task version or durable commit counter. Equivalent
task data retains its index and layout; settings-only changes update Project
metadata without rebuilding task projections, and changed intrinsic data replaces
statistics and both task-category lists together. The
[automatic refresh decision](../../.agents/notes/implemented/feature/2026-10-22-project-task-auto-refresh.md)
owns the scheduling and scope. With `pnpm web:dev`,
`/tests/mockups/auto-refresh.html` uses the real project page, styles and controlled
responses to explore periodic changes, delayed reads and recoverable failures
without Go or PostgreSQL. Production verification uses the real-service journeys.

Same-resource graph and detail refresh retain successful data while loading and
on recoverable failure. Errors stay visible during automatic retries until a
successful response clears them, including a failure before any successful read.
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
and stale-snapshot feedback remain explicit. The
[detail refresh decision](../../.agents/notes/implemented/bug-fix/2026-10-23-quiet-task-detail-refresh.md)
owns that presentation. Project and task changes release the old resource state.
Project listing and attachment metadata/content keep their independent refresh actions.
Live detail never changes graph counters;
a changed prerequisite can alter readiness without revising the task itself.
The dialog offers a full graph refresh when that difference is observed.
Reopening or refreshing details reads current PR associations; an attribute
update changes the task timestamp and uses the same stale-snapshot prompt.

The canvas supports pan, zoom and fit while editing and connection controls stay
disabled. The toolbar offers Fullscreen viewing, which fills the browser viewport
with the same mounted canvas. Exit fullscreen or Escape returns to the inline
graph without resetting pan, zoom or nodes. Fullscreen isolates background
controls and cycles Tab through its visible controls; exit restores focus to the
fullscreen button. Task details remain available above the graph, and Escape
closes details before exiting fullscreen. Both views share a counted body scroll
lock so either unmount order restores the original scrolling state. Fullscreen
is local to the mounted graph and is not saved as a browsing preference. The
[fullscreen decision](../../.agents/notes/implemented/feature/2026-10-22-task-graph-fullscreen.md)
records the modal and viewport ownership. Each node has sibling native inspection, Details and direction controls. A long graph starts with its
root visible at readable zoom; keyboard focus brings offscreen nodes into view.
The centered body-portal dialog has a 960px maximum width, 24px viewport gutters
(12px at 600px and below), and a maximum height of
`min(880px, 100dvh - 2 × gutter)`. The persistent heading, tabs and footer
surround an Overview panel and an Attachments panel. Overview owns its content
scrolling and pairs a reading column with a 265px metadata/relationship column
(225px at 850px and below); at 600px and below it stacks into one column.
Attachments fills the panel with adjacent file and preview panes at every
supported width, including 320px. Its parent body and panels do not scroll.
Short viewports, including 844×390, use compact heading and control spacing to
retain usable content without a second outer scrollbar. The dialog locks
background focus and scrolling,
supports its close button, backdrop, Escape and Tab,
and restores a surviving original trigger or a visible control in the active task view on close. Focusable
controls are enumerated with `tabbable` 6.5.0 using its normal browser visibility
checks. Same-origin preview frames bridge Escape and first/last Tab boundaries
back into that dialog lifecycle. Passive unmount restoration remains responsible
for focusing a surviving trigger after DOM removal.

## Markdown task descriptions

Task descriptions render CommonMark and GFM using the same `MarkdownContent`
renderer and styles as Markdown attachments: headings, paragraphs, lists,
checkboxes, quotes, fenced code, tables, links and images. Raw HTML remains text;
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

Run `pnpm web:dev` and open `/tests/mockups/markdown.html` for the production
`TaskDetailSurface` and `TaskDetailReading` composition with final styles and
frontend-only task/attachment fixtures. Description links, detail tabs, relations,
existing task actions and attachment management are interactive without Go or
PostgreSQL. Query parameters choose the task, tab, file, page mode and attachment
scenario. This entry and `/tests/mockups/attachments.html` share
`tests/mockups/main.tsx`; neither belongs to the production single-index build.

## Task attachments

Task details opened from the project list or graph start on Overview, which
retains descriptions, PR associations, relationships and metadata. Standalone
addresses initialize the tab and attachment selection from their navigation state. The complete task ID appears only in
its metadata row, beside a localized Copy button. This writes the exact ID with
`navigator.clipboard.writeText` and exposes success or a recoverable failure; the
ID remains selectable when browser clipboard access fails. Copy feedback belongs
to the displayed task and is cleared when that identity changes. The separate
Attachments tab places the path-addressed file tree, refresh and upload on the
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
including tables. Raw HTML remains escaped. Relative images and links resolve
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
header has a real Open in new tab anchor with `target="_blank"` and
`rel="noopener noreferrer"`, preserving the current task, Overview/Attachments
tab and selected attachment. The source dialog remains open with its local
state. A preview's neighboring Open in new tab action enters the same complete
task details at that file, even while preview content is loading.

`TaskDetailSurface` shares the full content and existing actions between dialog
and page: description, status, relationships, PRs, metadata, three-state setting,
automatic-execution permission, execution platform and attachment management.
`TaskDetailDialog` owns only the modal portal, inertness, scroll lock, focus loop,
Escape and focus restoration. `TaskDetailPage` provides an ordinary full-page
container, return-to-project link and language selector. The platform select
stays in the status row with live feedback beneath it. Status, permission and
platform use the same confirmation/review owner; file deletion keeps its own
modal confirmation. These interactions remain available in either container.
The standalone page and native frames do not install the outer dialog's keys.

`/projects/{projectId}/tasks/{taskId}` defaults to Overview. The existing
`/projects/{projectId}/tasks/{taskId}/attachments/{path...}` defaults to
Attachments with that exact file selected. `tab=overview|attachments` can
explicitly select a tab. With no file selected, Attachments uses the base task
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
an empty graph. Each successful graph revision still rereads full task details,
even when the graph projection is unchanged. Same-identity foreground auth
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
now belongs to the standalone-detail decision.

### Frontend-only attachment mockup

Run `pnpm web:dev` and open `/tests/mockups/attachments.html` on Vite's printed
origin. `tests/mockups/main.tsx` renders the production `TaskDetailSurface` and
CSS with `task-detail-fixture.ts` and the attachment `fixture.ts`. Task reads and
existing writes are intercepted by the in-memory fixture; native previews use
local files. The modal and page therefore share complete content and actions
without Go, PostgreSQL or service requests. Refresh resets fixture changes.
Object URLs remain valid through deletion and are released with their fixture.

Use `/tests/mockups/attachments.html?mode=page` for standalone Overview and
`/tests/mockups/attachments.html?mode=page&file=docs%2Fguide.md&scenario=files`
for complete details at a bundled attachment. Query `task`, `tab` and `file`
express fixture navigation; page changes use browser history while modal changes
stay local. The fixture URL differs from production's canonical task routes.
The `scenario` query selects existing attachment files, loading, empty, failure
and busy cases. All resources are development entries excluded from the
single-index production build; object URLs define no production navigation rule.

The mockup validates appearance and frontend behavior, not authentication or
persistent data. Local browser probes exercise the real portal dialog,
background inertness, CSS-hidden controls, frame boundaries, layered keys and
trigger restoration; unit layout emulation does not establish those browser
properties. The production `task-detail-page` and `task-attachments` journeys
use actual services on both runtime targets with source-qualified receipts.

## Frontend-only task browsing mockup

Run `pnpm web:dev` and open `/tests/mockups/browsing.html` on Vite's printed
origin. The fixture mounts the production project page and CSS with mixed,
fully completed and empty project graphs. It demonstrates the exact
two project tabs, newest-first category lists, topology-based standalone classification,
cross-chain prerequisites, direct standalone details and per-project tab, scroll,
expanded/collapsed and independent completed-item preferences across reloads.
It uses the final compact row CSS directly, including naturally growing long
titles and complete status/progress fields. Each expanded graph provides the
production fullscreen controls, retained pan/zoom, keyboard focus isolation and
task details above the fullscreen canvas, including on narrow screens. It distinguishes hidden all-complete
items from an empty category and a truly empty project and
preserves focus when the reveal action disappears. The self-contained
[task view mockup](../../docs/design/mockups/task-views.html) offers the final
visual presentation and frontend-only interaction without a development server. The scenario stays in the URL hash.
Graph, detail and empty attachment-list reads are served in memory; unexpected
requests fail instead of reaching a service. This development entry is excluded
from the production build and does not establish real-backend acceptance.

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

`web:test` runs coverage-checker, asset-publication and acceptance-receipt tool tests,
the full Vitest suite with V8 coverage,
then the exact statement gate. All `src/**/*.ts` and `src/**/*.tsx` files belong
to the product manifest, including the browser entry. Tests live outside `src`.
The checker independently compares that manifest against `statementMap` and `s`
in `.tmp/coverage/coverage-final.json`; missing runtime files fail even when they
were never imported by a test. Empty, malformed and incomplete reports fail.

The required comparison is `covered * 10 > total * 9` using BigInt. Exactly 90%
fails independently of display rounding. Pure-type declarations contribute zero
statements only after the pinned TypeScript compiler's emitted JavaScript proves
that they have no runtime body. Temporary native compiler inputs and outputs live
under this package's `.tmp/` and are removed after classification. Typechecking
remains a separate mandatory check; classification is not a substitute for it.

PR CI selects affected modules using the [repository routing rules](../../README.md#ci-selection);
main pushes run the full suite. The final `checks` job accepts only `success` or
`skipped` from every preceding job; failures, cancellations and other results fail
the gate. Deliberately unselected jobs report `skipped`. When selected,
`verify-web` retains its complete workload, including real embedded Go
builds and production-browser acceptance. The CI entry
`node packages/daynight-web/scripts/ci.mts` uses the same acceptance runner as
`pnpm web:acceptance`. CI supplies pinned Chromium installation, including Linux
dependencies, and the existing `pnpm web:test` command as preparation callbacks.
The runner completes coverage before starting browser installation, so apt and
Chromium downloads do not compete with the 5-second UI-test deadline. The CI
workflow selects official Ubuntu package archives before this step, as delivered
in [PR #148](https://github.com/codetreker/daynight/pull/148). Only the coverage child receives
`VITEST_MAX_WORKERS=2`, retaining its `forks` pool and per-file isolation. Browser
installation, including Linux dependencies and Chromium, has a 600-second command
deadline; coverage retains its 180-second deadline. Both failures remain
acceptance failures. Browser
installation still overlaps native production assets, Go/PostgreSQL and one normal
dev-ci source build/start. The dev-ci runner remains the owner of the built/running
image identity and full cleanup; the job retains its 20-minute overall bound.

Native functional checks start after the native process and browser are ready.
Their browser cleanup must pass before an atomic, run/source-bound permission
releases the container's twenty-nine functional checks. Capacity runs last, after all
preparation and coverage commands, container checks, full dev-ci cleanup and
container browser recovery have finished. Every browser phase retains one
worker and zero retries. CI runs controlled deployment fixtures before the
unified pipeline, and keys outer recovery and both artifact uploads to that
pipeline's attempted execution. After the pipeline and recorded recovery, the
Ubuntu web job runs `node deployment/dev-ci/tests/attachments.mts` once for real
volume/recreation/isolation and paired-backup proof. Its
`.tmp/attachment-deployment-*/` receipts join the existing deployment artifact.
Go module/compiler caches remain reusable.
The [pipeline decision](../../.agents/notes/implemented/testing/2026-10-21-web-acceptance-pipeline.md)
records the scheduling and ownership constraints. The web job uploads
`coverage-final.json` and `summary.json`, which records exact counts and the relative product-source
manifest. Coverage and acceptance artifacts are retained for 30 days. The
[deployment decision](../../.agents/notes/implemented/architecture/2026-10-20-embedded-dashboard-deployment.md)
records embedded HTTP/container smoke checks and concurrent dev-ci isolation;
the [production acceptance decision](../../.agents/notes/implemented/testing/2026-10-20-dashboard-production-acceptance.md)
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
```

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
macOS local acceptance runs the same 63 scenarios, additional combined
authentication checks and fixed performance budgets, with native filesystem
coverage qualified by its recorded capability. A local pass does not establish
macOS CI coverage. The [filesystem coverage decision](../../.agents/notes/implemented/testing/2026-10-23-native-development-filesystem-coverage.md)
owns this distinction. For networks requiring an npm mirror, use
`pnpm install --frozen-lockfile --registry=https://mirrors.cloud.tencent.com/npm/`
for the workspace. Export `pnpm_config_registry=https://mirrors.cloud.tencent.com/npm/` for the
acceptance CLI installation, and `DAYNIGHT_NPM_REGISTRY` for Docker builds. Both Compose stacks default to the official
npm registry unless the build variable is explicitly supplied.

The command builds real embedded assets and a new Go executable and owns a
separate PostgreSQL container/volume and ephemeral loopback listener. In parallel,
the normal dev-ci runner builds and starts the actual production image. Browser
execution proceeds through twenty-nine native functional scenarios, the same twenty-nine
functional scenarios through the production image's stream gateway, then five
native capacity/limit scenarios. The native process and PostgreSQL remain alive
through the capacity phase; other preparation commands and the complete
container stack have finished before that phase starts. No normal localhost service or dataset is used. Functional and
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

The [status journeys](tests/e2e/status.spec.ts) reuse the packed CLI and each
target's authenticated service with the same Alice identity. Origin, method,
headers and body pass through the redacting authenticated wrapper unchanged;
receipts exclude credentials. Status scenarios are task-status, task-status-conflicts,
task-status-recovery and task-status-transitions; total functional inventory stays
28 per target, with five additional native capacity/limit checks (61 combined).

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
No annotation, target topology,
capacity, coverage or cleanup gate is added or removed by this extension.

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
[combined acceptance decision](../../.agents/notes/implemented/testing/2026-10-21-task-attachment-cross-layer-acceptance.md)
owns data-sharing, rendering and independent reading proof.

The additional [combined authentication journey](scripts/acceptance/auth-combined.mts)
requires a separate receipt on each runtime target, alongside the 63
Playwright cases. It reuses the same installed package and normal Alice/Bob
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

The chain fixture creates 1,000 independent tasks, then attaches its 999 edges
with versioned PATCH requests from sink to root, avoiding repeated traversal of
a growing ancestor chain during setup. Complete snapshots compare every node's
dependencies with the fixture, including the chain's exact predecessor sequence.

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
Actual DOM fixed ports, Q≤12/tangency, card avoidance,
body/marker coverage and analytic curved dash phase cover every visible edge.
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

The 63-scenario inventory (34 native, 29 container), current manual/periodic refresh,
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
[platform journey](tests/e2e/task-platform.spec.ts),
[standalone-detail journey](tests/e2e/task-detail-page.spec.ts),
[project-settings journey](tests/e2e/project-settings.spec.ts),
[execution-time journey](tests/e2e/task-execution-time.spec.ts),
[capacity scenarios](tests/e2e/capacity.spec.ts) and
[acceptance runner](scripts/acceptance.mts) map to the
[W1–W15 requirements](../../docs/spec/daynight-web.md) and
[language requirements](../../docs/spec/daynight-web-i18n.md) and
[execution-timing requirements](../../docs/spec/daynight-task-timing.md) as follows. Names are stable
scenario annotations validated in each target's report.

| Requirement | Production checks |
|---|---|
| W1 | `project-list`: more than 50 projects, cursor requests, unique cards and navigation to a later-page project |
| W2 | `project-graph`, `deep-links`, `task-attachments`, `task-detail-page`: project entry, direct HTML reload, complete standalone task/tab/file navigation and history without source-tab state; modal selection remains local |
| W3–W4 | `project-graph`, `project-view-tabs`, `refresh-staleness`, `failure-recovery`: exact statistics, ordinary-component tabs and member progress, direct standalone details, independent completion filters, per-project tab/scroll/expansion restoration, dependency reclassification and consistent full refresh |
| W5–W7 | `project-graph`, `keyboard-focus`, `capacity-chain`, `capacity-merge`, `capacity-shared`, `capacity-external`: complete projection data, bounded overview/induced edges, explicit expansion/reset, state markers and existing detail/viewport actions |
| W8, TI12–TI14 | `detail-navigation`, `refresh-staleness`, `task-detail-page`: shared complete dialog/page content and actions, title-bar/attachment popouts, task/tab/file history, query-preserving login, nested confirmations, precise/conflicting/unknown writes, automatic full-detail reads and retained geometry/state |
| W9 | `refresh-staleness`, `failure-recovery`, `deep-links`, `capacity-limits`: periodic status updates and automatic recovery, owned-database failure/restoration, correlated errors, empty/not-found states, delayed request replacement and complete size refusal |
| W10 | Native and container functional targets, exact image identity and dev-ci cleanup receipt |
| W11 | Strict raw Go/V8 coverage reports, validated complete browser/performance receipts and the final `checks` result |
| W12, TI6–TI7 | `detail-navigation`, `keyboard-focus`, `narrow-layout`, `project-view-tabs`, `refresh-staleness`, `task-attachments`: centered 1440px/320px dialog geometry, independently scrolling content and persistent controls; graph/standalone entry, layered fullscreen Escape, trigger disappearance, inert/scroll release and same-origin frame keys |
| W13 | `task-status`, `task-status-conflicts`, `task-status-recovery`, `task-status-transitions`: same-data packed-CLI/ordinary-graph lifecycle, three-state transitions, direct completion, reopening and same-state no-op, metadata/attachment preservation, status menu and permission confirmations and tabs, cancel/Escape/focus, invalidation, stale CLI metadata, CLI/Web same-version competition, pending protection, exact int64 digits, real-commit response loss, real graph failure and task/SPA-project identity/focus/browsing preservation |
| W15 | `task-platform`: status-row selection and confirmation, zero-write dismissal and select-focus restoration, set/clear, shared status/permission gate, exact versions, stale/unknown GET-only recovery, cross-task late ownership, manual-start lock, field propagation and bilingual narrow layouts |
| TT3 | `project-settings`: real-service direct entry/reload, administrator save and independent member read, project isolation, exact settings versions above 2^53, stale conflict and demotion, read-only member recovery, actual commit with lost response and failed-read retry without PATCH replay, bilingual 320px/390px form/control/navigation containment and unclipped text |
| TT1–TT2, TT4–TT6 | `task-execution-time`: real PostgreSQL crossing with graph deliveries held and an incorrect client wall clock, one-second local progress, stable focus/DOM/geometry/edges/viewport, real saved-threshold changes, installed-CLI completion and frozen polling, unknown legacy starts, sub-minute/multi-day/shared/external cards and standalone rows, bilingual 320px/390px layout; browser GET/HEAD only, with fixture mutations through authenticated API or installed CLI |
| FA1–FA12 | `task-attachments`: installed CLI and production UI share real task/files on native and container targets; exact bytes, file mutations, detail tabs, shared full attachment panel, unique preview scroll owners, rendered formats, standalone address/history and embedded-local selection. Independent real-service probes add end-of-document wheel/keyboard, native PDF final-page paint, fault/retry and unchanged task/graph proof |
| TI8–TI9 | `task-description-markdown`: installed CLI and real API preserve Unicode/CRLF Markdown bytes and versioned full replacement; bilingual 1440px/320px rich rendering, escaped HTML, URL policy, task-root images/encoded references, paginated loading/list failure/retry, invalid/missing/preview failure states, one-controller navigation/focus, overwrite refresh, modified native href and HTML frame interaction; inspection→Details→relative attachment→close preserves graph selection/geometry/view |
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
SHA-256, PostgreSQL/browser versions, pipeline stages, target phases, capacity
measurements, container image identity and cleanup outcomes. Each stage records
its result, start/end times, observed command process identities and spawned
process groups. Each browser phase records its own result, browser identity,
Playwright process/group and `browserCleanup` result. Raw reports and screenshots
live under `native/functional/`, `container/` and `native/capacity/`; the unchanged
schema 1 capacity receipt is `native/capacity/performance.json`. Additional mandatory
combined receipts are `native/auth-combined/target.json` and
`container/auth-combined/target.json`, both schema 1 with `kind: auth-combined`.
They require all eleven named checks, source/browser/installed-package identity,
old/new restart process identity and passed browser/resource cleanup. They retain
safe observations and hashes, not credential/configuration bodies or raw logs.
The 63-case report validator remains independent. `CI` requires a clean checkout matching
`GITHUB_SHA` and the pinned browser for the current Linux or macOS host. Playwright uses one worker and no
retries; skipped, flaky, duplicate/missing or incomplete scenarios fail validation.
When selected, the web CI job archives `daynight-web-acceptance` separately from raw
coverage for 30 days. Inspect the artifact from the exact workflow run and its
tested checkout identity, which is normally a merge revision for PR runs. A pass
requires the strict union of twenty-nine native functional and five native capacity/limit
scenarios (34 native total), plus the twenty-nine container functional scenarios. Every
phase and target rejects missing, extra or duplicate scenarios and skipped/flaky/retried results.
Installed-CLI handoff, container callbacks and recovery require matching source
commit/tree/dirty state as well as existing package/artifact ownership. A missing
or mismatched tree field fails; no old-receipt fallback is introduced. The tree
identifies committed source and does not fingerprint local modifications or prove
an executed platform/gate. Lifecycle attachments to each status scenario retain
CLI arguments/outputs/exits, raw-byte digests, task/graph snapshots, captured Web
requests/responses and declared controlled faults under the same run identity.
Browser identities must agree across a target's phases; every fixed graph's five
timing repetitions, independent size refusals and cleanup/recovery must pass.
Local receipts retain their source and browser identity; they do not establish
clean hosted delivery results. The
[paint decision](../../.agents/notes/implemented/bug-fix/2026-10-20-long-dashed-dependency-paint.md)
retains raster evidence and visual tolerances needed to assess that mechanism.

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
The [CI efficiency decision](../../.agents/notes/implemented/testing/2026-10-21-ci-validation-efficiency.md)
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
resources immediately. After the native functional phase, an atomically written
`container/container-permission.json` binds its completed cleanup to the exact
acceptance run ID, dev-ci run ID and source SHA. The container callback records
its identity before waiting, and inventories browsers only after permission;
its `ready.json` is diagnostic timing, not browser permission. Any stage failure
or unexpected native-server exit cancels sibling work, drains started tasks and
preserves failures before final cleanup.

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
phases in reverse order: `native/capacity`, `container`, `native/functional`.
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
[pipeline decision](../../.agents/notes/implemented/testing/2026-10-21-web-acceptance-pipeline.md)
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
The [layout decision](../../.agents/notes/implemented/feature/2026-10-20-task-graph-projection.md)
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
adapter returns finite left-to-right node positions and routed edge points for
220px-wide visible cards with 96px compact or 136px expandable heights. The
read-only React Flow canvas consumes these results without changing domain
objects. React Flow owns task nodes with those exact dimensions, native ResizeObserver measurement,
keyboard behavior, viewport and controls. One memoized SVG in its public
ViewportPortal renders every planned smooth M/L/Q path, with stable edge identity,
arrowheads, external-context dashes and accessibility semantics. It shares the viewport's
transform, so selection/pan/zoom reuse geometry without per-edge reactive state.
Canonical routes retain native arrow markers and the full planned geometry. Dashed body
paint uses `routes.ts` to derive locally horizontal rotated lines and short native
vertex paths, with the original 5/4 pattern and continuous positive arc-length
phase. Each line is at most 8,192 graph units long; additional cuts fall inside
the existing dash gaps to bound GPU work without removing route geometry.
Solid bodies remain native. Pieces are noninteractive and hidden from the
accessibility tree; canonical edges keep their existing identity/semantics. The
[paint decision](../../.agents/notes/implemented/bug-fix/2026-10-20-long-dashed-dependency-paint.md)
owns the pinned raster evidence, phase preservation and visual tolerances; the
[bounded-line extension](../../.agents/notes/implemented/bug-fix/2026-10-22-bounded-dashed-dependency-lines.md)
owns the GPU stroke limit and its added DOM cost.
Initial placement uses current visible layout bounds after the viewport and positive
measured canvas dimensions are ready, fitting within 0.8–1 zoom or anchoring the
leftmost rank at 0.8 zoom. The root remains vertically centered when already
leftmost; otherwise the topmost upstream node starts at a 32px canvas inset.
Dependency geometry does not require connection-port DOM or per-edge endpoint readiness.
Graph-local inspection Context supplies presentation roles while controlled node
geometry/data and memoized content retain stable references. Memoized collapsed
root rows keep their existing detail-selection behavior until expanded. Changed snapshot indexes
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
