# daynight-web

The React/TypeScript Web app provides a public product introduction and a private
workspace. The workspace implements Team creation and settings, project browsing,
account-owned Worker observations and cloud configuration, a cross-project in-progress Task overview, cursor pagination,
request cancellation, runtime API decoding, native browser routing and a pure
dependency graph model with horizontal and vertical layouts. Project task views
use an IndexedDB summary cache and the authenticated task-sync endpoint.
Project navigation includes Overview, Task list, PR list and Tags. The independent PR
workspace reads saved summaries in six-item cursor pages, filters by state and
title/number, and opens the existing PR detail reader. Visible workspaces reconcile
every 15 seconds; hidden sections retain filters, pages and selections while
cancelling reads. Task graph errors do not block PR browsing. The
[PR read design](../../docs/design/github-pr-reading.md) owns synchronization
states, unknown counts, identity admission and retained-page behavior. The list
selects one primary synchronization notice while retaining independent diagnostics.

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
shows the public introduction, `/setup` selects the zero-API guide, `/auth/complete`
confirms and publishes an account before replacing the return target, and other pages
use the existing authenticated lifecycle. `/login` is explicit and `/projects` is
the project index. Team settings share one page shell: `/teams/{teamId}/settings`
opens General, and `/teams/{teamId}/members` opens Members & invitations. Business
APIs require a browser session or PAT; project resources also require current membership, while Worker resources belong to the
current account and filter their saved task observations by current project access. The Go service
retains loopback-only listening. Trusted same-origin previews, relative resources
and keyboard behavior remain unchanged.
The [Web workspace decision](../../.agents/notes/archived/feature/2026-10-22-web-auth-workspace.md) records the rationale for the frontend lifecycle choices; the
[activation decision](../../.agents/notes/archived/architecture/2026-10-22-authentication-activation.md) records the rationale for production composition and credential-private acceptance.

## Webhook management and delivery diagnostics

Open Webhooks in the authenticated sidebar to visit `/webhooks`. Its catalog is
validated for the current service and account before private requests are admitted.
Choose Personal or an explicit Team in the page; this selection is independent
of the sidebar Team. Configuration, subscriptions and deliveries share one
list/detail page, with native dialogs for changes, signing-key maintenance and
original delivery inspection. Explicit Delivery links retain their endpoint and
owner. Deleted configurations expose retained history as a read-only view. If
the endpoint configuration is missing but history remains readable, the explicit
history route uses an ID-only context without invented configuration fields or
redelivery admission. Established history contexts retain their independently
authorized reads and interaction through later configuration errors; those errors
are shown separately and cannot restore withdrawn manager state or erase a
previous authoritative missing-configuration observation.

Delivery history supports server filtering and pagination, original targets,
attempts, historical acknowledgements, current failures and late observations.
Payloads require an explicit independent read and are displayed as text only after
identity, canonical Base64, length, SHA-256 and UTF-8 verification. A shared resource
observation prevents old list or detail responses from restoring withdrawn private
data, including URL-only redaction that still permits full event and payload
access. Management and readable membership observations remain separate, so a
continuous admin-to-member change withdraws old manager views and signing secrets
while preserving authorized history and payload state. A validated missing Attempt history withdraws the selected Delivery and
its private current projection without changing a confirmed operation receipt.
Known payload deadlines also apply to delayed responses; metadata retention uses
authoritative reads.

Changes use the observed configuration version and one fixed operation identity,
request body and digest. Admission repeatedly validates the same frozen original
resource target; selecting another eligible Delivery cannot authorize it. Manual
redelivery adds the observed original generation;
202 confirms registration, and subsequent reads observe actual sending. Its
original receipt and current Delivery generation stay distinct. Unknown results
reconcile the original receipt using GET; reloading keeps minimal operation
metadata and never resends a missing body. Private URLs, secrets and payloads stay
in scoped memory. Background verification pauses new admission while preserving
drafts, focus, open dialogs and loaded pages; confirmed access and expiry changes
withdraw the corresponding content. Storage cleanup failures remain visible
without blocking logout or identity invalidation. The
[Web requirements](../../docs/spec/webhook-web.md) and
[design](../../docs/design/webhook-web.md) own this behavior.

## Assistants

Open Assistants in the authenticated sidebar to visit `/bots`; selecting an
assistant opens `/bots/{id}` in the same workspace. The 256px list and conversation
sit side by side when the workspace has at least 676px of available width after
global navigation. Below that width, the page shows one column: select an
assistant to read its conversation, or use Back to assistants to return to the
list. Expanding navigation can change this layout without resetting search,
drafts or reading positions. The list, messages and details scroll independently.

Search filters assistant names; no matches and an empty account have separate
states. The list keeps the server's order and shows concise startup or Worker
warnings. Use its refresh button to reload; a failed read retains the previous
list and displays the error. Select an offline or failed assistant to inspect its
actual reason.

Choose Create assistant beside the list title to open a compact, name-first
dialog. Its summary identifies the actual Worker and Agent; expand it to read
full paths, effective model and reasoning effort, and their configuration sources.
Adjust settings optionally selects a Worker, ordinary absolute working directory,
Agent, Model and Reasoning effort. Defaults stay implicit in the request; local,
cloud and successful-preference values are not described as native defaults.

Browse opens the selected Worker's directory view in the same dialog. Navigate
using the reported paths, filter loaded entries, show hidden directories or load
another page. Select directory applies the path and binds that Worker; Cancel,
Escape or the browse close button returns to the retained form without applying a
selection. Manual absolute paths remain available when browsing is unsupported.
Model choices and supported reasoning efforts come from the target Worker's
native capabilities. Unknown capabilities and actual failures do not produce
invented options.

Explicit directory, Agent, Model or effort choices bind the resolved Worker.
Changing Worker clears all machine-specific choices; changing Agent clears Model
and effort; changing Model clears the form's effort override and resolves its
default again. Individual default choices remove their overrides, and Reset all
defaults also releases the Worker binding. Unavailable, unsupported, offline or
stale choices retain their actual reasons. Initial loading keeps the name editable;
background checks and retries retain the draft.

Before submission, Cancel or Escape closes the dialog and restores its opener's
focus without creating an assistant. Submission blocks cancellation and duplicate
requests; IME composition cannot submit. A confirmed rejection keeps input for
correction. For an unknown result, Check creation reads the original Bot ID,
including after closing and reopening; it never creates a replacement to discover
the outcome. The dialog follows the visible viewport, keeps its actions reachable
with an independently scrolling body, and leaves the existing Session, draft and
reading position intact.

The conversation has one header for its name, Agent, Session state and controls.
Display selects Conversation (the default) or Standard; approvals, errors and
required responses remain visible. Assistant details opens a separate details
panel; the name itself is not a button. More actions contains Session refresh and
Close chat. Closing a chat or returning to the list only exits the current reading
selection; it does not stop the Worker-owned Agent or delete the assistant.

Details shows the full name, Worker, frozen working directory, Agent, startup and
Session information. A window at least 1280px wide **and** a stable combined
conversation/details area at least 760px wide uses a 340px nonmodal side panel,
leaving at least 420px for the conversation. Otherwise details opens as a modal
drawer. Closing it restores the trigger's focus. Use Enter Session fullscreen for
Focus mode, which keeps the same Session and reading position; details and other overlays stay inside its focus boundary.
Escape closes the top layer before exiting Focus mode.

Messages and input share a reading column capped at 760px. Long code and tables
scroll locally; use Latest to return from older messages. Empty-conversation
suggestions only fill the draft and focus the input. Enter submits and Shift+Enter
adds a line; composing text with an IME does not submit. During execution,
providers that support Steer expose a separate supplement action, while Interrupt
remains an independent button; Enter does not interrupt. Model, permission and
command choices follow the current Session's capabilities and native confirmation.
The input remains reachable in short layouts and grows to a local scrolling limit.
Switching assistants restores their independent drafts and reading positions.

Reloading or reopening an assistant can show its recent saved history before
details, Session metadata and the first history page arrive. The authenticated
account owns these bounded localStorage snapshots: six targets, at most 150
complete entries per target, with the existing character budgets. Only accepted,
settled real history updates them. Preview rows are read-only, cannot download or
load resources, and do not restore historical approvals or live activity. Verified
pages replace covered rows while preserving the timeline and reading owner.
Account changes, authoritative access loss and cold-target deletion withdraw
preview eligibility before best-effort storage cleanup. Storage failures retain
the live conversation and do not establish that physical clearing succeeded.

Startup success is not proof of a connected Session or permission to send. Use the
error's own retry or check action: history failures retain readable messages,
unknown sends check the original operation without resending, and recovery errors
retain their specific reason. Account-change waiting preserves confirmed
content and local editing while remote operations remain gated; confirmed access
loss clears the affected private state. Archived history is read-only and has no
composer. Delete assistant is available in list-row actions and details, with a
separate confirmation. Unknown deletion results use Check deletion; completion
requires both Worker and server cleanup to be confirmed. Old Test URLs cannot
bypass the same deletion barrier.

The [management requirements](../../docs/spec/bot-management-web.md) and
[management design](../../docs/design/bot-management-web.md) own layout and
management behavior; the [Session requirements](../../docs/spec/bot-session-view.md)
and [Session design](../../docs/design/bot-session-view.md) own shared controls,
identity, drafts and reading continuity. See [assistant browser validation](#assistant-browser-validation)
for executable checks and evidence limits. Standalone Test Sessions retain their
own entry. The assistant composer currently sends text; displaying an existing
image resource does not establish image-upload support. Webhook/MCP configuration
is not available.

## Public product entry

The public `/` page explains the shared work layer for developers, teams and their
coding agents. Its primary action opens a local interactive example; onboarding
continues through `/setup`. The introduction remains available when signed in.
The document account owner supplies the identity hint for login/workspace navigation;
loading or failure does not block the public content or authorize private data.

`features/landing/` owns the page, bounded example data and interaction. Typed
English and Simplified Chinese messages cover copy, example documents, FAQ,
identity status and metadata; changing language preserves example selections.
Styles are scoped beneath `.landing-page`. The production page contains no
prototype controls or simulated account state. Default HTML share metadata and
locale-aware page metadata use the existing Vite-to-Go asset pipeline.

The [requirements](../../docs/spec/daynight-landing.md) and
[design](../../docs/design/daynight-landing.md) own the complete visitor journey
and public/private ownership. The
[decision](../../.agents/notes/archived/architecture/2026-10-26-public-product-entry.md)
records the original trade-offs.

## Daily setup guide

The header's book icon and visible Setup guide link appear before the language
selector and open public `/setup` in a new tab with native link behavior and
`noopener noreferrer`. The opener retains its current page. Two always-expanded
sections offer independent MCP and CLI with Agent skill paths. MCP covers
configuration of Codex, Claude Code or Copilot CLI for the current user and browser
account authorization, and provides a read-only `team_list` request to verify connection.
MCP shell commands use POSIX quoting and instruct Windows users to use a POSIX
shell such as Git Bash. The guide links to the public `/mcp` installation manual, the selected client's
official documentation and `/account`, where Tokens manages tokens and authorized
applications. The five CLI steps cover installation with Node.js 22 or newer,
device login, repository project discovery or creation, Agent skill installation,
and registering and viewing a first task. Each gives its execution location,
prerequisites, copyable text and success signal. Remote terminals can use
`daynight login --no-browser`; Agent reload instructions follow the installer's
output for the selected launcher and User/Project scope.

`SetupGuidePage` uses typed `messages.setup` catalogs inside a public shell with a
localized title, breadcrumb, skip link and language selector. It derives the MCP
endpoint from the current origin; the CLI's default login service remains
`https://daynight.cc`. Direct access, reloads, in-page navigation, client and locale
changes, copying and focus/visibility restoration make no additional requests. The document owner performs one initial `/me`; the guide mounts no provider discovery, task cache or business-resource lifecycle.
Project and account links navigate to a new document and normal authentication.

Command blocks retain selectable source text, exact newlines and argument quotes.
One current copy operation disables the copy buttons until it settles. A floating
status message reports success or manual-copy recovery without shifting content.
Unmount, locale and client changes invalidate old results, including completion
handlers that might otherwise release a newer pending copy. Client choice survives
a language change and resets to Codex on reopening. The public reading layout
supports long addresses and controls at desktop, 390px and 320px widths. Go
serves direct GET/HEAD requests and reloads through the normal no-store HTML
handler; `/setup` and its descendants are reserved from authentication callbacks.
The [requirements](../../docs/spec/daynight-web.md#日常使用引导) and
[design](../../docs/design/daynight-web.md#日常使用引导页) own the behavior and
mechanisms. The [path decision](../../.agents/notes/implemented/feature/2026-11-11-setup-mcp-guide.md)
records the trade-offs.

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
validation, notices and already displayed errors. Login, workspace, invitation and device authorization
pages expose the shared language selector. Shared management and project creation dialogs inherit the
current language without their own selector or preference notice; native formatters
render dates and counts. Language changes retain form inputs, dialog and
one-time secrets, identity and pending requests without restarting operations.
It composes the project list, graph, shared task-detail surfaces and My Workers
list/detail with private project creation, account/token pages, member/invitation management,
project execution-warning settings and explicit invitation acceptance.

`WorkspaceSidebar` groups navigation by the current Team or Personal space, My,
and Tools in one scrollable region. The current scope contains the Team selector,
Projects tree and Team settings; My contains Shared with me, My Workers and
Assistants; Tools contains Webhooks and Test sessions. Webhooks starts at
`/webhooks?owner=personal` and retains its independent owner selection and catalog
gate. The selector shows the known Team or Personal space type above its name; an
unknown type leaves that line empty. Project list headings and document titles use
Projects, with the confirmed scope in the eyebrow. Direct project breadcrumbs do
not infer ownership from the sidebar Team. The Team trigger
opens a viewport-constrained popover in desktop, rail and mobile drawer layouts
without shifting navigation or changing the sidebar state. It preserves native
Team links, keyboard access, pagination and recoverable errors. On a fresh
workspace entry, the account-scoped Team preference restores independently of
the current project or global page. Explicit Team routes use their URL's Team;
ordinary in-page navigation keeps the current choice, including a failed save.
Returning to `/projects` rereads the saved preference. Standalone task and
attachment pages defer restoration until the workspace appears. Team-dependent
links and its project directory wait for a verified selection, while the page's
own resource and the shared-project directory can load independently. Restoration
failures expose a workspace retry without replacing the saved choice. Only a
verified missing Team clears that choice and restores Personal. Background
checks retain the confirmed Team and all loaded selector pages until a complete
refreshed prefix is available; actual changes and recoverable errors remain
visible. Explicit refresh still reads the directory. When the confirmed selection
is Personal, the Team settings entry is omitted from the sidebar in all layouts.
Ordinary Teams have one Team settings link that opens General and stays selected
in both settings sections, regardless of the Team name. Ordinary members retain
this entry to read the roster and leave their Team. Direct Personal settings and
member URLs remain available under their existing access rules. The
[personal Team navigation decision](../../.agents/notes/implemented/feature/2026-11-05-personal-team-sidebar.md)
records this visibility choice. The
[browser Team preference decision](../../.agents/notes/archived/feature/2026-11-04-browser-team-preference.md) records the rationale for storage, identity and recovery behavior. The current Team's indented list remains visible on Shared with me, while shared-only projects stay
outside it. Project, member and settings routes select
the corresponding project; both Worker routes select My Workers. Links preserve native
modified clicks, expose full names through accessible text and titles, and
truncate long visible names. Project children appear in expanded desktop and
mobile navigation and are hidden in the folded rail. Initial loading, empty and
failed reads have localized feedback and retry; Load more traverses subsequent
pages without removing earlier links on failure.

Only the sidebar toggle stays in the footer. Desktop widths are 190px expanded and
68px collapsed. The footer stays reachable on long pages and short viewports;
icon entries retain accessible names, hover titles and selected route styling.
The topbar avatar uses the authenticated profile image, cropped to a circle,
and displays the account initial while loading or when the source is empty or
fails. It opens an account menu whose Account settings item navigates to
`/account`. The localized trigger exposes its expanded state; keyboard access,
outside-click and Escape dismissal, focus restoration after Escape, and route
change dismissal keep the menu usable across desktop and narrow viewports.
Shared management `Identity` displays the existing nullable avatar in account,
grant confirmation and member surfaces. A nonempty source loads without rewriting;
loading, empty or failed sources retain the two-character fallback. The avatar's
identity and source isolate its local state without remounting surrounding
pages or dialogs. It uses a decorative, circular 30px image, or 49px in the
account profile. The [Web requirements](../../docs/spec/daynight-web.md#管理身份展示)
and [design](../../docs/design/daynight-web.md) own the display contract and
mechanism.
Account profile, credentials and user prompt tabs participate in browser Back and
Forward. Their history state contains only an account-bound tab selection; the
existing credential and prompt owners retain their drafts and operation results.
Worker monitoring, configuration and prompts tabs also participate in Back and
Forward, scoped to the current user and Worker; both editing owners retain their
drafts and operation state.

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
Route changes, the desktop breakpoint, actual identity loss and unmount close
the overlay and release its isolation and lock. Account-change waiting keeps it
open with its focus containment and scroll lock.
Sidebar changes preserve the mounted project, cache, detail and graph
viewport without another request or synchronization loop. The
[sidebar preference decision](../../.agents/notes/archived/feature/2026-10-25-sidebar-preference.md) records the rationale for these state boundaries; the
[account menu decision](../../.agents/notes/archived/feature/2026-11-04-topbar-account-menu.md) records the rationale for account entry placement. Cross-tab live updates and server or cross-device
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
Project navigation and account-change waiting retain it; real logout and session expiry dispose it so old results cannot reach a new identity. A project 404 stays a resource error.

Each document confirms its account once with `/me`; ordinary route changes, focus and visibility events do not repeat it or pause healthy work. The root account owner listens for same-origin changes and rereads the current marker. A known different account, a trusted principal mismatch or a changed user fence enters a sticky refresh-required state. The original account, scope, content, drafts, focus and decoded images remain; remote reads, writes, controls and media stop, and in-flight network work is cancelled. Local editing, copying and selection remain available. The active header offers a keyboard-accessible reload that retains the full URL, including in native dialogs and fullscreen views. A later return to the original marker does not resume automatically.

The marker is only a hint, not authentication. Missing or invalid storage does not prove logout; storage and channel failures are visible and retry their failed local stage. Before a current 401 or logout clears state or publishes null, the owner checks the source and marker to avoid overwriting a newer account. Cancellation does not establish server rollback. The [account synchronization decision](../../.agents/notes/implemented/architecture/2026-11-11-document-account-sync.md) records the trade-offs.

The `/me` request alone uses browser HTTP revalidation with `cache: no-cache`.
Successful responses carry `private, no-cache` and a strong ETag over the complete
identity-bound representation. An unchanged authenticated response is bodyless
304 on the wire and reuses the browser's stored profile; reload still verifies the
current login without retransferring an unchanged avatar. A different account,
changed profile or missing HTTP cache receives 200. Authentication and profile
read failures retain no-store errors; no custom `/me` IndexedDB is used.

Team settings share a heading, the current Team name, and horizontal General and
Members & invitations links. Native links preserve direct access, reload and browser
history; the navigation wraps on narrow screens. General displays the saved name
with its rename action, the selectable Team ID with an adjacent copy button for every
viewer, and a separate deletion panel at the bottom. Members & invitations contains
the roster and its existing role, removal and self-departure actions, followed by
admin-only invitation management. The
[settings sections decision](../../.agents/notes/implemented/feature/2026-11-10-team-settings-sections.md)
records the grouping and lifetime choices.

Clipboard success and failure are reported locally; failure leaves the ID selectable
and retryable. Pending copies are guarded and results are discarded when
the Team or identity context changes. A stable Team-bound owner mounts each section
on first visit and retains visited sections while either is current. Section changes
suspend hidden content without losing drafts, confirmations, pending or unknown
writes, or one-time invitation links. Off-route owners remain only as required by
protected operations and receipts; inactive completion cannot focus hidden content.
Leaving or deleting a Team returns to Personal only when the live browser location
still shows either settings section for that Team, preserving unrelated destinations
and later Team choices.

On a healthy return from hidden or unfocused state, the account signal first
rereads the shared marker. Team owners then refresh the current selection, loaded
directory prefix and active settings section; the invitation list refreshes only
after membership and management permission are confirmed. A sticky account-change
pause prevents these reads, and foreground return does not repeat `/me`.

Team settings and invitations retain loaded content, the invitation area, drafts
and open confirmations during account-change waiting and ordinary
background reads, without loading rows or disabling local editing. Initial reads
and actual errors retain their own feedback. Writes require fresh Team, membership
and invitation admission; explicit reconciliation retains the original operation
result and never replays a write or infers its success from a read.
A changed selected member role or version invalidates its confirmation. Project
settings, membership and transfer results retain their original scope and wait for
admission before publication. Current access is rechecked where required; a
confirmed settings write awaiting access is reread without replaying it.
Confirmed one-time invitation receipts remain bound to the original identity and
available until closed even if resource access changes. Invitation directories
and new management operations still require current authorization. Actual failures
and access loss retain their existing handling.

Requests use same-origin browser credentials and preserve request IDs, cancellation and
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

The account-owned `/workers` list shows Workers that have reported within the
last 72 hours. `/workers/{workerId}` presents Runtime monitoring, Configuration
and Prompts as peer tabs, defaulting to Runtime monitoring. Arrow keys wrap
between tabs and Home and End select the first and last; tab and panel
accessibility associations and hidden-panel isolation remain intact. Runtime
observations retain that window, while cloud configuration and the Worker prompt
are independent resources. Configuration includes tool paths; Prompts contains
the Worker prompt editor. Both routes support direct access, reloads and
login return destinations. They mount inside the existing authenticated
workspace and share its navigation, styles and language. Sidebar project loading
or failure does not admit or block Worker reads. Worker ID participates in the
page's resource key, content focus and mobile navigation lifetime.

The list uses only the actual summary: machine name, platform, last report time,
task observation state and currently visible task count. It does not infer an OS
release or load every detail. `null` task count means information unavailable;
observed zero means idle. Stale task information retains its observation time.
The last report label and localized absolute date and time share one line; the
time uses the browser time zone and includes seconds. The complete collection
groups online Workers first while preserving the
service’s creation-time and Worker ID order within each group. Heartbeats do not
change that relative order.

The list also reads current monitoring summaries in batches of at most 100 loaded
Worker IDs. Cards show the scheduling phase and capacity, including the capacity
stale indicator, without admission reasons or monitoring timestamps and age.
Detail shows scheduling and admission, actual capacity, parallel
activities, current failures and the latest recovery before host resources. Task
associations open the existing task detail; fixed diagnostic categories and real
retry times are displayed without inventing external waits or deadlines. Claim failures may show a selectable, wrapping project-relative worktree path or a localized unavailable reason; the path provides no file operation or ownership proof.

Monitoring is independent of the existing Worker snapshot. Redis observation
time and a monotonic browser clock mark an observation stale at 90 seconds and
expired at 3600 seconds. Missing monitoring, read errors and offline Workers have
distinct presentations; failed monitoring reads retain dated observations and
leave host resources visible. Project withdrawal removes associated private
details and invalidates list reason sets whose individual scopes are unavailable;
late responses cannot restore them. Total Worker capacity remains visible, and
reported identity-free reasons return in the projection on an admitted reread.
Background checks retain page interaction and
configuration drafts. The [monitoring contract](../../docs/spec/daynight-worker-monitoring.md)
owns its fields and permission projection.

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
They reuse TaskCacheScope for authenticated lifetime, account admission and
Project withdrawal generations; Worker data never enters the project cache,
IndexedDB or a global registry. Independent reads capture generations before
requesting data, withdraw matching private projections on access-negative events
and fence late responses. A Worker detail filters affected task rows; a list
invalidates counts without per-project provenance until an authoritative reread.
Reads and publication both wait for identity confirmation, and abort signals,
resource identity and request generations fence late results. The shell's
`readEnabled` pauses private work when an account change requires refresh, retaining the last observation and workspace memory until reload.

The visible Worker snapshot channel owns a 30-second single-flight refresh
and a one-second ticker. The list traverses every cursor privately and replaces the collection
only when the whole traversal succeeds. A failed page retains the previous
complete collection and exposes retry. Its last response supplies `observedAt`
and the paired `performance.now()` receipt for a common server-time anchor.
Online means less than 120 seconds since `lastReportedAt`; exactly 120 seconds
is offline. Exactly 72 hours remains recent; later observations disappear, and
an expired runtime overview becomes unavailable. This does not clear or block
the Configuration tab. Browser wall-clock changes do not affect
these rules.

Read failure, hidden state and account-change waiting freeze the last published
server time and mark retained content stale. Visibility return starts a fresh read when admitted; only success recalibrates the anchor and resumes
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
404 clears the old runtime observation. Configuration reads handle their own
resource result. Initial loading, initial failure, empty results and
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

### Cloud runtime configuration

Configuration edits the cloud target and shows the Worker's last reported
application results. It supports concurrency, polling interval in milliseconds,
recovery limit, default Agent/model/args, and selected Projects with native
overrides. Repository root and local paths, Worker identity, service connection
and credentials, and agent control mode remain locally managed.

Project override controls preserve inheritance separately from an explicit
provider-default model (`null`) and empty arguments (`[]`). Arguments are edited
as a JSON string array. Invalid raw inputs remain in the form with validation
feedback. The Project chooser loads the complete accessible directory; selected
inaccessible Projects retain only their ID and saved override intent. Removing
saved Projects requires confirmation before the single target PUT. Cancel and
Escape make no write.

A successful save confirms a target, not local application. Per-item results
retain their target revision, actual value, pending/applying/applied/error state,
current diagnostic, last failure and retry time. Project removal outcomes remain
visible after the Project leaves the desired list. Offline Workers retain their
last confirmed results and may receive a newly saved target when they reconnect.
Without a recent runtime observation, the page does not invent a current online
state. An uninitialized `desired:null` resource is not editable; the browser
cannot create the first target.

`api/worker-configuration.ts` strictly decodes the account-owned resource.
`features/workers/configuration/model.ts` and `useWorkerConfiguration.ts` keep
latest resource, draft baseline, raw input and submitted snapshot separate.
Opening either editing tab mounts the page-level editing coordinator. Switching
tabs preserves the mounted editors and drafts while pausing reads for the hidden
resource. The active, visible, identity-admitted configuration tab performs its
own five-second single-flight refresh without using the runtime observation
clock. Prompt reads and writes do not depend on configuration initialization,
validation or Worker online status, and failures in either resource do not block
the other. One navigation guard covers both drafts: cancelling a leave returns to
the dirty tab, or the last edited tab when both are dirty, and restores focus.
The page owner stays retained while either resource has a pending or uncertain
write or a configuration receipt awaits publication, without aborting or replaying an already dispatched prompt PUT.

Account-change waiting retains the editor, dialogs, local input and unapplied
Project selection while private requests and new saves remain gated. In-flight
saves retain their submitted snapshot and result classification until admission
resumes. Background directory reads preserve the complete loaded collection,
including an empty collection; actual failures retain their error semantics.
Background results do not replace draft input, focus or selection. Saving uses
the draft's target revision; observation updates cannot invalidate that baseline.
A conflict retains the draft and exposes the latest cloud value for explicit
loading. Definite failures retain input. A potentially committed write is
reconciled by GET before another save, without replaying PUT or attributing a
matching current value to that request. Later input is not overwritten by an
earlier submitted snapshot. Account and Worker lifetimes fence reads and writes;
configuration and drafts stay in page memory, outside project storage and
IndexedDB.

The [Web requirements](../../docs/spec/daynight-web.md#我的-worker),
[Web design](../../docs/design/daynight-web.md#我的-worker-列表与详情) own the page
behavior. The
[observation decision](../../.agents/notes/archived/architecture/2026-10-29-web-worker-observations.md)
records the original rationale. The
[snapshot protocol](../../docs/spec/daynight-worker-snapshots.md) owns the exact
DTOs and permission filtering; the
[client reporting contract](../../docs/spec/daynight-worker-reporting.md) owns
collection, reporting and version age. The
[configuration contract](../../docs/spec/daynight-worker-configuration.md) owns
target/application semantics and form ownership; the
[editor decision](../../.agents/notes/archived/architecture/2026-11-04-web-worker-configuration-editor.md)
records those choices. Component or controlled-browser results
prove their stated frontend scope; combined Server, CLI and Web acceptance must
separately establish real reporting, resources, permissions and recovery.

## Project ownership transfer

Project settings show the confirmed owner and offer transfer to an owner Team
admin. Background checks preserve the dialog and its paged selection; transfer
waits for current authorization and verifies ownership again. The dialog accepts a Team selected from the paged
membership list, a UUID, or a same-origin Team page URL. Preview displays the
target and predicted access before confirmation. The request binds the observed
ownership and target versions and the authenticated user; conflicts require a
new preview and confirmation. Direct grants and invitations remain intact.

A validated receipt determines success. Retained access is installed in the
Project access session; loss of access revokes the matching Task cache generation
and clears open private views, including unsubmitted transfer previews. A dispatched
transfer retains its result and a private-data-free unknown check. The source Team is checked by ID for navigation:
a confirmed 404 goes to Personal, while network errors preserve the success
notice and offer a retry. A lost response remains unknown, even if a later read
returns 404; checking current state never replays the transfer. See the
[transfer decision](../../.agents/notes/implemented/feature/2026-11-05-web-project-transfer.md).

## Project execution-warning settings

`/projects/{projectId}/settings` opens the project settings workspace from the
project header. Execution and reminders is the default section; members and
invitations share the workspace, and `/projects/{projectId}/members` opens that
section directly. Direct GET/HEAD entry and reload use the embedded application. Every member can read the saved threshold;
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
reconciliation leaves Save blocked and exposes a read retry. Leaving the settings
route cancels an undispatched save; a dispatched save and its result remain owned
by the original user and Project for presentation on return. Unresolved outcomes
remain retained until read-only reconciliation or scope invalidation. Returning
reads authoritative settings without overwriting a draft; a changed version
shows the current saved value and blocks saving until the user cancels the draft.
An equal current value needs no write and does not establish an unknown outcome.
Confirmed Project revocation hides private data and invalidates reads without
cancelling a dispatched save; its result waits for renewed access. Identity scope
termination rejects old results, and cancellation never proves that a committed
write was rolled back. The existing
account-change pause preserves drafts and focus. Ordinary access
checks do not reload the settings resource; Save waits for the current check and
verifies the role, ownership and observed settings version before dispatch. Ending
the original identity or Project scope invalidates its requests and results.

Project resources include required `settings.version`,
`settings.executionWarningMinutes` and `ownership:{teamId,version}`. The resource
codecs share validated raw JSON source-field maps and convert only declared
Project settings, ownership and grant version paths. Unknown nested-field
semantics remain intact; no browser reviver source-context feature is required.
Versions above 2^53 remain exact bigint values and mutation encoding sends JSON
numbers. Missing contract fields do not acquire defaults.

Project synchronization merges intrinsic summaries by ID and exact business
version in the current durable collection, then merges authoritative dependency
states whose taskVersion matches the current Task. These states supply readiness
and statistics to the ordinary-task GraphIndex. Unchanged summaries and states
retain task and index references;
settings and ownership merge independently by their exact versions within one
epoch. Equal ownership versions must identify the same Team; contradictions fail
synchronization. Metadata-only changes preserve task projection. A new epoch
snapshot fully replaces Project, including legitimately lower restored versions,
while old-history ownership cannot carry forward. Clock-only responses retain the graph and index while refreshing the separate
latest `GraphSnapshot.observedAt` and its paired `receivedMonotonic`. No settings
edit changes task time or graph geometry.

## GitHub connection settings

Project settings show GitHub connection, PR synchronization intent, and independent polling and Webhook status to all members. Administrators can discover the configured App's installation, connect or reconnect, switch synchronization, set the polling interval and disconnect. Discovery checks the App's access to the Project repository, independently of the operator's GitHub account. A first connection remains off; reconnecting an unavailable binding retains its saved intent, while disconnecting turns synchronization off and retains saved data. Private repository data is shared with Project members.

The switch displays the last confirmed `syncEnabled` value. Enabling requires an available service and connection; an administrator can disable an already enabled setting even when the service or authorization is unavailable. Synchronization off is neutral and retains historical observations without presenting old errors as current failures. The PR tab and saved records remain readable, including during a new initialization; refresh reads saved data and does not enable synchronization.

Management uses the independent GitHub resource's exact version and shares the synchronous Project management guard. The separate switch request never submits an interval draft. A conflict or unknown write outcome retains the draft and original page ownership and holds the guard until an admitted read reconciles the state or the scope ends, without replaying the write. An existing binding can be disconnected even when the App is unavailable or unconfigured. The [runtime design](../../docs/design/github-connection-runtime.md) describes the server behavior.

## Project deletion

Project Settings offers owner Team administrators a deletion preview and exact
name confirmation. The preview identifies the Project, its observed counts and
active Worker claims; those observations are not DELETE conditions. Names with
control characters use reversible JSON escaping. A confirmed receipt is retained
independently of local completion and preserves a success notice across navigation. During an admission pause, deletion settles
locally without cleanup, automatic reads or navigation. On admission, cleanup
uses the original cache generation. A confirmed receipt withdraws only the original admitted cache generation.
Navigation and dialog closure are skipped when the submitted dialog, input,
section or route has since changed. If persistent cleanup fails after withdrawal, retry targets the
matching user, Project, user fence and denied generation without broadcasting
withdrawal again or resending DELETE. The denial may use a different ticket;
a stale ticket cannot clear a newer generation. Cleanup and navigation
can be retried independently. A dispatched request
with an unknown outcome is never replayed, and a later 404 does not prove that
the deletion succeeded. Settings saves, GitHub management, ownership transfers and deletion share
a synchronous management guard. The [Web design](../../docs/design/daynight-web.md#项目删除)
owns the operation and identity boundaries.

## Persistent task summaries

`TaskCacheProvider` wraps every authenticated route outside the shared detail
session. Its scope follows the user and session generation, including standalone
task and attachment routes. The origin-local `daynight-task-cache` database uses
schema 12 and idb 8.0.4, with `userScopes`, `projects`, `summaries`, `details`,
`profiles` and `sessionHistory` stores. Schema 12 clears project, summary and
detail records and their watermarks before strict parsing, preserving user fences,
profiles and compatible Session-history formats. A full snapshot can clear the
refetchable Session catalogue. Upgrades from schema 1 through 4 rotate user fences; schema 7 Session records lack the complete-empty
proof and are cleared. Task summaries, search results and details require `tags` references; missing or malformed references fail parsing. Missing fields are not supplied with defaults.
Upgrade failures roll back, and old connections close on versionchange. User fences, project generations and validated manifests guard late
responses and cross-tab transactions. `lifecycle.ts` checks ownership, canonical
fences/generations and actual counts for both active and invalidated manifests.
Complete graph and sync responses are not rejected by stored node, edge or
Session-map counts; cache quotas remain independent.
An invalidated manifest has a recognized reason, null epoch/Project/watermark and
zero task/edge counts; it cannot retain a usable incremental baseline. The shared
details store and guarded transaction interface support intrinsic content reuse,
bounded LRU and business-version-driven detail reads.

`beginSync` reads the epoch, greatest exact accepted summary `updatedAt` and slim
Task execution bindings in its existing transaction. Its `TaskSyncTicket` keeps
that immutable request baseline in memory; snapshot observations use only
returned Tasks, while delta observations overlay returned Tasks on the baseline.
`applySync` validates the transaction's complete durable set and atomically saves
changed summaries with that watermark. Every snapshot/delta record contains its
required type, nullable parentId/assignedTo/cancelledAt and complete current
properties from the task row's database snapshot. Each ordinary Task has a
separate same-version dependency state; Goal records have no dependency state. Higher task
versions replace whole summaries and property maps; missing keys remove old
values without property tombstones or ordinary epoch changes. Equal-version
content must match all intrinsic fields, including assignedTo, and all own
property keys and JSON values: object order is
irrelevant, array order matters, and missing differs from null or an empty array.
Older responses cannot revive removed properties. Snapshot states replace the
collection; delta states patch only matching owner versions. A readiness-only
change is persisted and published, including across tabs. A late state for the
same owner version can temporarily replace a newer prerequisite observation.
Graph projections omit properties and Goal resources; the typed summary map
retains both complete properties and Goal existence. Only project-sync summaries
advance the watermark.
Details, mutations, request time, Project time and `observedAt` cannot establish
project coverage. UTC seconds plus nine fractional digits preserve ordering;
business versions remain bigint. The default ten-second server overlap can
repeat its final rows indefinitely. Old/equal intrinsic rows with unchanged
dependency states do not rewrite storage, invalidate detail records, replace
published indexes or broadcast. Network,
HTTP, decoding, quota and IDB-completion errors preserve the prior valid cache
and watermark without partial publication. Server reads trust canonical stored
properties without repeated normalization, field or capacity checks; natural
decoding, encoding, database and transaction errors remain visible. Complete
properties increase transport, parsing, full-set client validation and summary
storage costs. The detail LRU byte budget does not bound total summary bytes, and arbitrary legal
maximum payloads are not guaranteed to fit every browser quota.

After identity verification, a project publishes its validated local summary
snapshot while task-sync runs in the background. Valid empty snapshots render
normally; missing or invalid baselines retain loading until synchronization.
Recoverable sync failures retain visible summaries and expose Retry. Summary
publication does not authorize detail bodies or task writes: summary-backed details require this mount's successful online project sync. A direct opening instead requires a current, principal-bound Task observation and does not depend on a graph. A local-only detail mount keeps its
visibility gate local and leaves shared session observation unchanged, so an
already accepted operation can finish preparation in its original authorized
history; this mount's first live receipt still requires its own opening GET. `Daynight-User-ID` is checked before decoding or acting on sync, detail and task
mutation responses. A verified different principal synchronously pauses remote work and retains the old content until reload. Headerless or malformed-principal errors retain
valid cached content. Project-sync not_found withdraws matching project admission. A trusted Task GET or write not_found withdraws that detail and revalidates project access; Task absence alone does not establish project denial. Captured ticket checks
prevent an old-generation response from clearing a replacement generation. Scope invalidation aborts current work and releases memory before its
user-specific persistent purge; ordinary disposal closes resources and preserves
the durable base. Account-change gating covers durable reads and positive publication;
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
carry userFence/revokedGeneration. Independent projections compare the event to
the generation captured at read start, even if cleanup has already advanced the
durable manifest. The manifest persists successive generations atomically, and denial tickets
carry their complete ancestry. New-generation denial withdraws older observations
even if replacement hints were lost, without letting an old denial withdraw a
proven later observation. Corrupt unknown history is isolated and reread. A bound cold cache peer records a matching durable denial
without rebroadcast. Stale hints cannot replace a newer generation or denial. Failed IDB opening,
blocked upgrades, abnormal close, corruption or writes use existing visible
error/Retry states and retain an allowed current view. Missing or malformed user
scope records are repaired in one shared-cache transaction: replace the fence,
clear only that user's summaries/details/profiles and invalidate its project baselines.
The repair never parses or reuses the damaged fence. For that user-corruption
repair, memory binding, scope retirement and hints wait for commit; a cold scope can then bind the replacement,
while an already-bound scope signals the root owner and waits for reload. A failed
repair rolls back without retiring the detecting scope, exposing a retryable
storage error. Other users remain intact, and stale tickets fail against the new
fence before publication. There is no silent network-only fallback. `Task sync` diagnostics report cycle/project IDs,
received/changed/duplicate counts, cache hit and apply duration; duplicate includes
ignored old versions. Failure diagnostics expose categories and a depth-limited allowlist of cause
names/codes, without raw messages, stacks, task bodies or credentials. The [cache architecture](../../docs/design/daynight-task-sync.md)
owns the algorithm, schema, failure rules and detail integration.

## Persistent task details

`TaskDetailSessions(scope)` uses the same authenticated scope and details store as project summaries for summary-backed details. Direct openings retain validated Task observations only in memory and do not write the details store. `detail-cache.ts` validates intrinsic bodies against
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
do not create openings. For summary-backed details, project-generation changes immediately clear the old body,
PR data and loadedRevision, cancel old reads/pending bodies and reset freshness
and committed-version floors. Render-time generation checks suppress old content
before effects, even when the replacement GET hangs or fails. Operation intent
and confirmed/unknown phases survive, while canceled reconciliation becomes
retryable; only same-generation refresh failures retain the successful body. During account-change pauses, rendering getters retain only previously observed
memory values; requests, transactions and new-mount admission remain blocked until reload.

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
The cache stores versioned profile content in a separate store; profile data never enters task records or task versions.

The detail places status and assignee in one 24px compact group, followed by
platform and readiness, with automatic execution on the right. The assignee
control shows the confirmed value with a 16px avatar; rows use 17px avatars.
Names and avatars retain actual nullable values. Missing profile data or a null
name displays a short UUID, failed images use an identity placeholder, and only
an explicit hasProjectAccess=false result marks a former member. Long names
retain accessible full text and narrow layouts keep controls within the viewport.

The summary-backed picker uses the complete qualified-person manifest from task-sync and loads only missing or changed profiles. A direct detail reads the member catalogue independently under its current Task observation. Ordinary reopening reuses matching
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
withdraw a replacement generation. The [request-reuse decision](../../.agents/notes/archived/bug-fix/2026-11-04-task-view-request-reuse.md) records the rationale for the versioning, HTTP cache and scan-cost trade-offs.

The task toolbar orders Assignee, Status and Tag filter. The ordinary Goal view
adds one Child task tag filter after them, applying the same condition to every
Goal's direct-child rows. Child filtering is independent of each Goal's own tags
and retains its selection through category changes, pagination and collapse.
Cards contain child rows without their own filter controls. Search results place
the shared project tag filter directly after Status; child filtering belongs to
the ordinary Goal view.

Assignee supports All, Assigned to me, Unassigned and a person; status supports
all five Task statuses. Project conditions must match the same task before
pagination. Standalone rows match directly; a chain with any matching ordinary
member retains its real representative and all ordinary children. Changing
project filters resets the task lists to page one. Full-chain progress, readiness,
dependencies, statistics and graph use the complete index. Child filtering also
preserves Goal composition, in-progress and pause counts, and Session summaries.
Overview positioning adjusts project filters that hide its target. Tag panels
retain a readable width within the viewport as toolbars wrap on narrow screens.
The [assignment design](../../docs/design/daynight-task-assignment.md) owns people,
mutation and presentation mechanisms; the
[Web design](../../docs/design/daynight-web.md) owns tag filtering and lifecycle.

Project task search submits the original expression to the server, matching IDs,
complete titles and Markdown descriptions, including completed Tasks and chain
members. Nonempty draft edits do not change the applied query. Clicking × or
deleting the input to empty clears the search without submitting an empty query,
cancels in-flight reads and keeps focus in the input. Search filters and cursor
pages reset; the ordinary view retains its filters, pages and scroll position.
Search results open a live Task detail, including
when project graph synchronization fails. Errors and empty results remain
distinct; the server owns matching, ordering and context. The
[requirements](../../docs/spec/daynight-web.md#项目任务搜索) and
[design](../../docs/design/daynight-web.md) own the interaction and lifecycle.

## Steps reading and writing

Task details always expose Steps after Overview, in both the dialog and standalone
page. `tab=steps` preserves the tab through direct access, reload and browser
history, including details without a Session. Reading shows the ordered title,
four-state status and task-local ID; multiple expanded rows render Task-root
Markdown and timestamps through the same attachment controller as Overview.

`TaskDetailSessions` owns a separate lazy Steps resource in memory. Summary,
parent-detail and confirmed mutation versions invalidate it; identity, cache
generation and version admission fence late responses. An ahead summary-backed resource waits for summary admission and requests parent/project refresh. Direct Steps use the current live parent version and bounded parent/collection rereads; stale responses
are reread against the highest verified floor, including pending parent details.
Refresh and reader release retain that scalar floor within the same cache
generation. Confirmed parent deletion fences in-flight reads and asynchronous
admission so late responses cannot restore a deleted detail. First-read errors, valid emptiness and
retained-content errors remain distinct and retryable. A Steps 404 checks the
parent before retiring access; 403 remains a refusal, and parent 410 uses the
existing deleted-task presentation. Retirement and the last active reader's
unsubscribe release complete collections, including pending admission, unless a Steps write operation still needs them. Steps never
enter the TaskDetail LRU or IndexedDB.

The list mounts at most 100 rows per page, with global numbering, previous/next
buttons and a numeric page input. Paging makes no API requests; expansion remains
bound to IDs across pages, same-task tabs and refresh reordering. Both languages
and the 320px layout retain reading and recovery controls. The four-state menu
submits through the same owner as Task writes and retains the confirmed state
until the response is validated. The owner reconciles the Steps resource, parent
detail and authorized summary before allowing another write. Conflicts and
unknown outcomes expose recovery without replaying the operation; a failed
readback keeps the submission gate closed. Position controls move up, down, to
either end or relative to a selected Step. The picker filters the complete
collection by name or ID, mounts at most 100 candidates and retains selection
across filtering and pages. Confirmed moves locate the actual page and preserve
expansion and focus by ID. The add form appends or inserts before or after a
selected Step, using the same bounded picker and preserving its anchor by ID.
A missing anchor or a changed creation time leaves the draft intact and requires
a new position decision.
The shared owner validates the complete response, and an unknown result retains
the original ID for read-only reconciliation. Confirmed additions locate and
focus the new row. Existing Steps can be edited in the same draft workspace;
identity and creation time prevent an old draft from updating a replacement.
Deletion requires confirmation and preserves unrelated Steps and references; a
deleted edited item requires an explicit draft decision. At heights up to 500px,
a single scrollable tab row reserves
reading space; the tab owner reveals its target after focus, selection styling
and locale updates. At heights up to 600px, pagination scrolls with the list so
its controls cannot cover the remaining reading area. The [resource requirements](../../docs/spec/daynight-task-steps.md#web-阅读)
and [design](../../docs/design/daynight-task-steps.md#web-资源与单一写入所有者)
own the complete resource lifecycle and the remaining write architecture.

## Session display

Task detail current reads require the selected Session tab and a visible document.
Native readers begin with reading disabled; tab commits and document visibility
changes update a gate separate from execution ownership and authentication. Hidden
panels cancel or defer complete current reads and their timers while retaining
healthy native channels, content, drafts and reading positions. Reopening a healthy
panel resumes its existing three-second startup/report observation rather than
reconnecting. Visible discovery, retry, explicit refresh and recovery retain their
existing behavior.

Each Task current flight retains its slot until transport and admission waiting
settle, including cancelled requests. Archive-ready final identity checks defer
until visible and still verify the original execution and archive content.
Completed current discovery rechecks tab, document and request identity after
`scope.ready` and every subsequent wait. Herdr keeps its existing hidden-channel
and lease-release policy; independent Test/Bot authority observation is unchanged.
The [Task Session requirements](../../docs/spec/task-sessions.md#task-详情的完整-current-读取)
and [current-read design](../../docs/design/task-session-protocol.md#task-current-的读取可见性)
own these boundaries.


Native timeline Task, Test and readable archived Sessions share the Display menu beside Refresh.
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

## Herdr Sessions and recordings

The task Session host keeps the native Web timeline and dispatches Herdr executions
to a read-only terminal preview with explicit control acquisition. Current project
access permits reading both modes, while only the persisted Session owner may
send messages, answer requests, change settings, run commands, interrupt a turn
or control the terminal. Other project administrators and members retain live
content, history, resources, Display, Refresh and fullscreen with execution
interactions disabled. Native clients bind the verified claim owner; terminal
clients check the validated owner identity separately from lifecycle and transport.
Their local gates supplement the server owner check.

Hidden terminal views close their viewer channel and release the browser lease; Worker recording
continues independently. Controls become available only after Worker confirmation.
During hidden state or account-change waiting, the last confirmed screen, draft and
same-control confirmation remain in place while input, receipt polling and lease
renewal pause. A recovery read alone does not permit input: a fresh channel
observation matching the current fence and control epoch is also required.
Actual disconnections and errors remain visible.
Unknown initial submission disposition and resuming automatic input require
separate decisions. Unknown manual input is never automatically resent.

The main Session tab automatically follows the task's actual claim and lifecycle,
without an execution-record selector or catalogue refresh row. Active claims keep
their existing Web or Herdr reader; a claim waiting for registration never borrows
an older Session. Completed claims resolve their original Session through a
read-only current request and display fixed history without input or control
operations. Task completion does not imply archive readiness: pending, failed and
unavailable archives retain their status and recovery action. Opening, refreshing
or reconnecting the page does not launch a native conversation or resend input.

With no claim, the tab may show the latest actual Session as read-only history.
Only a confirmed complete empty inventory hides the tab; initial reads and
failures remain distinguishable and recoverable. The former per-user/project/task
recording selection is discarded without clearing unrelated storage. Background
checks preserve eligible content, drafts, display preferences and reading position;
identity changes and access revocation still withdraw the affected content.

Older executions remain available through Session recordings in the attachment
sidebar. Each record opens its fixed original execution in the shared reading
area and has no attachment mutation actions. Ordinary file previews and upload
drafts retain their state while a recording is selected.
The shared cache stores successful first pages and confirmed empty catalogues per
authenticated user, project and task. Opening or reactivating the view refreshes
the first page even when cached: confirmed empty stays hidden during refresh and
existing entries remain readable. An empty first page with a continuation does
not by itself confirm an empty catalogue. Exhausting later pages establishes a
separate persisted empty proof while retaining the original first page and cursor.
Refreshing a confirmed empty catalogue follows an empty first page through its
continuations until a record appears or the catalogue is exhausted. Failures
retain eligible content and offer retry. When cache reads work but a refresh or
pagination transaction cannot write, the view retains valid content and offers
retry without publishing a successful response whose ordering is unproven. Task
version does not establish history freshness. Fences and generations guard revoked or stale
results; complete storage failure can conservatively hide a newer result or lose
a denial across a restart after all tabs close, as described in the
[cache design](../../docs/design/daynight-task-sync.md#5-indexeddb-与去重).
This cache grants no live control or archive access.
Verified complete frames support direct seeking, stepping and playback; partial
recordings remain labeled and playback stops at every gap until the reader
explicitly continues. Archive reading establishes no control connection.
The [Herdr Session Web design](../../docs/design/herdr-session-web.md) owns
identity, verification, control and playback behavior.

## Task discussions

Task details always provide Overview, Steps, Attachments and Discussion tabs, followed
by Session while its existence is being resolved or actual execution history is
available. Discussion works before
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
consumed-after ID. Visible and incoming count windows retain complete bodies
without message, page or retained-data byte admission;
explicit navigation can replace displayed history, which remains reachable by
before/after ID paging. Only a reading anchor, the latest confirmed receipt and
one pending POST reservation can be fixed, so repeated own posts cannot prevent
older unseen messages from progressing. The new-message count describes retained
incoming messages and does not claim the service's total backlog.

All Web reads request details=true. Author names and Agent provider badges use
immutable message snapshots; missing or blank names use a separate full account
ID label, and current worker settings never rewrite history. Safe Markdown keeps
line breaks and local code/table scrolling without raw HTML or remote image
loads. Reply previews use a known parent directly; an out-of-window parent loads
only on demand with at most two bounded list reads and an exact target check.
Message details use a nested native dialog that owns Escape/Tab and restores
focus within page, modal and fullscreen task details. Document hiding and account-change waiting retain the same dialog, reading position, reply and editable draft
while reads, sending and publication remain gated. Actual scope retirement clears them.
The controlled-browser regression runs with `pnpm exec playwright test --config
tests/navigation/discussion-identity-playwright.config.ts` from this package; it
holds identity and Thread responses while exercising the production interface.

The composer preserves original whitespace and code indentation. Ctrl/Command+
Enter sends outside IME composition. A valid 201 confirms the remote message and
ends its response timer before same-account authentication re-admission; later
local failure cannot turn that confirmation into an unknown result. Only the
submitted draft/reply revisions clear on success. Explicit refusals and unknown
outcomes preserve draft content, and refresh never repeats a POST. Equal body
text is not a submission identity. Validated parent access errors clear the
scope; a missing reply or pagination message is a local error that retains data.

The [design](../../docs/design/task-thread-web.md) owns the full decoder,
capacity, lifecycle, keyboard and verification rules. The
[decision](../../.agents/notes/archived/architecture/2026-11-03-task-thread-web.md)
records the original trade-offs.

## Task execution time and possible stalls

A local-only snapshot has revision zero and no server clock or successful receipt.
It displays neither a refreshed timestamp nor running durations or stall warnings;
completed durations still use their persisted endpoints. Overview and completion-time readings use the local snapshot time for provisional
display, then switch to the live server sample. This provisional time never
establishes execution time, completion facts or sync coverage.

The successful task-sync API reader captures `receivedMonotonic` immediately
after `response.text()` completes, before JSON decoding, source scanning or
validation. `getTaskSync` returns local `TaskSyncRead {sync, receivedMonotonic}`;
`useTaskGraph` carries that receipt through history, IDB and index work and pairs
it with the response's database `observedAt`. `receivedAt` remains the local-wall-clock refreshed label. A stable
`TaskExecutionClockProvider` at each project or standalone resource page root advances the server sample with
`performance.now()` elapsed time and publishes saved threshold changes in the
same layout effect. Its estimate includes post-receipt render/commit delay but
does not compensate for network delay before that receipt; client
`Date.now()` does not determine duration or warnings.

Mounted running tasks with a known start and completion-time consumers share one
visible-page one-second ticker. Completion readings use the server sample at
nanosecond precision, or the local snapshot anchor for a cached preview. The
completion hook publishes only semantic bucket changes. Completed execution
durations subscribe only to threshold metadata and use their persisted endpoint
difference; unknown timing has no active subscription. Without a snapshot all
samples and settings remain unknown and no ticker starts. Hiding pauses ticks,
visibility return publishes monotonic elapsed immediately, and ordinary guarded
polling separately reanchors time. The last active unsubscribe, clearing the
sample and provider unmount release timer/listener work. The provider stays mounted
across first receipt and same-project presentation changes. There is no new
per-card request or server worker. Clock samples and settings stay outside
graph-index, projection and layout dependencies.

Task cards, standalone rows and Goal child rows show live elapsed or a frozen
original execution duration for done and cancelled records. Todo tasks and
incomplete intervals show no inferred duration; cancelledAt never supplies an
execution endpoint.
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

While access initially loads, the project heading reserves the geometry of the
localized settings link. Its inaccessible placeholder is replaced by the link
without narrowing the title or moving the restored page position. The header does
not display the current user's role; the members and invitations section retains
role details. The
[header-role decision](../../.agents/notes/implemented/simplification/2026-11-12-project-header-role.md) records this choice and the earlier layout rationale; the existing
[shared-scroll decision](../../.agents/notes/archived/bug-fix/2026-11-03-shared-task-list-scroll.md) records the rationale for one task-list page offset per project, independently from Overview and graph viewports.

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
and share copy. The top bar exposes the shared selector; the graph dialog has no
local selector or preference feedback in either mode and consumes the current
application locale. Task details consume the current
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
`DAYNIGHT_UNIAUTH_CALLBACK_URL` in the Vite environment to the same public callback
URL configured for Go, registered with UniAuth for the development browser origin.
Go can receive this value through YAML or its environment; Vite does not read the
server configuration file. Vite proxies exactly that callback
path through the same Go API target. When unset, no callback proxy is added. The five required
backend authentication settings and explicit HTTP test policy follow the
[deployment guide](../../deployment/localhost/README.md); changing the browser
origin does not relax callback or Cookie-write Origin checks.

An identity-scoped Team projects provider supplies both the sidebar directory and
Team project cards from one request owner. Shared with me mounts its own provider
for shared cards, refresh and pagination; it loads independently of Team preference
restoration. Entering or leaving that page retains the Team directory and its
loaded pages. Mutation callbacks refresh the current Team directory and any mounted
shared directory, including when a transfer receipt arrives after navigation. Each
directory requests 50 items per page, preserves server order, and follows
`nextCursor` through Load more. Repeated IDs count once.
Project navigation retains loaded pages. Refresh discards old pages and cursors;
late responses cannot repopulate them. Direct-grant controls remain available
for the final direct administrator; inherited-only participants have no editable
grant version. After confirmed self-removal, the panel revalidates current access
and navigates away only after authoritative withdrawal. Inherited access retains
the Project page; network, protocol or server failures keep a visible read retry
and never repeat the write. Creating a project or confirmed loss of one's own
access refreshes the current directories; a new authenticated identity starts
with new directories. The [project navigation decision](../../.agents/notes/archived/feature/2026-10-27-sidebar-project-navigation.md)
records ownership and pagination choices.

The application implements public `/`, explicit `/login`, the `/projects` index,
`/projects/{projectId}`, `/account`,
`/invitations` and the standalone
`/projects/{projectId}/tasks/{taskId}/attachments/{path...}` reader, direct URL
reload, browser back/forward and a generic not-found page. All resource reads use
the current authenticated identity. A project without a saved section preference
opens Overview, with six statistics and an overall progress list from the complete
snapshot. Its recent rows include every unfinished ordinary task-chain component
and ended components from the latest seven local calendar days. A row shows
the representative title, ended/total count, separate done and cancelled counts,
and a floored integer percentage. A Goal ends only when all ordinary members
are done or cancelled; all done means successful completion, all cancelled means
cancellation, and mixed terminal results use the UI-only ended outcome. Its
latest member terminal time determines recency: completedAt for done and
cancelledAt for cancelled, with external prerequisites excluded. Known recent
member times supply evidence when some historical times are unknown; without
known recent evidence, ended Goals remain available in the task list.
The standalone aggregate row combines every unfinished standalone task with known
terminal results in the same window. It remains visible at 100% when only recent
ended tasks remain, as do recent ended Goals, and preserves the result breakdown.
Project statistic cards retain full-history totals.

The window includes today and the previous six days in the browser's local time
zone, starting at local midnight six dates ago. For example, October 27 includes
terminal results from October 21 at 00:00 onward. Local date arithmetic preserves
calendar-day semantics across daylight-saving changes. Current time advances
from the server sample and monotonic elapsed time after synchronization;
local-only summaries use their provisional client-time anchor. One project-owned
deadline updates Overview at midnight, pauses while the
page is hidden, and recalculates on visibility recovery without requiring a new
snapshot.

Overview displays 20 top-level entries per page; Task chains and Standalone
tasks each display 15. A whole Goal is one entry regardless of expanded children; the single
standalone aggregate is one Overview entry. All display sequences sort by
`in_progress`, `todo`, then terminal outcomes before pagination, using individual status for
standalone tasks and complete component status for chains. Within a status,
exact newest-first order remains stable; the standalone aggregate follows
matching-status chains.
Pagination shows the current item range and filtered total with previous/next
controls; one-page results have no pager. Each list retains its own page during
the project visit. Changing either filter resets both task lists to page one; shrinking
results clamp the page immediately. These display slices do not truncate the
cached graph, statistics, Goal progress or dependency context, and do not add
requests or stored page preferences.

Clicking a progress row selects Task list and the matching category, switches to
the destination Goal's page, then scrolls, focuses and briefly highlights it.
The standalone aggregate selects its list's first page. Explicit positioning wins
over saved task-list scroll for that activation; ordinary category switches
keep the current page position. The [recent browsing decision](../../.agents/notes/archived/feature/2026-10-27-recent-task-pages.md) records the rationale for the shared window and paging policy; the [progress decision](../../.agents/notes/archived/feature/2026-10-26-project-overview-progress.md)
retains the original aggregation and navigation rationale. The adjacent Task
list section contains Standalone tasks and Task chains. Desktop section navigation is vertical on the
left of the selected content; narrow screens use horizontal tabs with matching
keyboard direction. The outer choice is stored per project in browser
preferences, so the first render after reload or a new visit already shows the saved
Overview, Task list, PR list or Tags selection. User switches add browser history without changing the URL; traversing history does not save a new preference. Empty
projects retain all section destinations.

Overview and Task list use one `ProjectView` snapshot, synchronization loop and detail
owner. Task list mounts on first selection and stays mounted while hidden and
inert outside Task list. Leaving Task list or its Task chains category closes the
current graph dialog and clears its temporary opening state; an ordinary return shows
the list without reopening it. Browser history traversal can restore an earlier graph selection. The retained task subtree does not start another
cache, index or refresh loop. Task details remain outside either section panel.
Inactive inner-category contents unmount while their associated tabpanel IDs
remain stable.

The Task list heading's nonzero pause badge opens a native popover containing
exactly the assignee-scoped eligible ordinary tasks counted by the badge. Rows
show title previews, truncation, short IDs and lifecycle labels; selection opens
the exact task through the existing detail history while retaining list state.
The badge is the focus return target, with the visible tab or project heading as
a fallback if it disappears. Unchanged snapshot checks preserve the open menu,
focus and scroll; eligibility changes update it without an extra detail read or
polling loop. The [pause-list decision](../../.agents/notes/implemented/feature/2026-11-14-project-paused-task-list.md)
records the navigation and data-scope trade-offs.

Within Task list, an absent category preference selects Task chains; later
new visits restore the project's last saved inner category. The standalone badge
counts unparented unfinished standalone tasks matching the selected assignee; the
chain badge counts each ordinary component once when an unparented member is both
unfinished and matches that assignee. Proposed, todo and in-progress members are
unfinished; a finished root does not hide a matching successor. Classification uses
the complete ordinary graph before Parent scoping, and external edges do not join
components. The Goal badge counts matching containers in all statuses. Badges use
the complete snapshot independently of status, tag, search, pagination, category,
graph and expansion; the chain badge has its own localized tooltip. Toolbars report
all entries matching the current filter against complete category totals,
independently of page size.
Both categories default to all statuses and include all history. Status and
assignee selections are shared in memory during the project visit.

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
unsatisfied prerequisite produces an explicit Blocked / 被阻塞 badge; done and
cancelled prerequisites are satisfied. A Goal row
expands a task list through its main native button, independently of its
sibling View dependencies / 查看依赖关系 button. The list contains every other
ordinary-component member exactly once, with `in_progress` first, then `todo`, then `proposed`,
then terminal outcomes. Terminal children use exact completedAt for done or
cancelledAt for cancelled in descending order, with unknown times last. Equal
terminal times and unknown-time ties retain snapshot order, as do children in
other status groups. Fresh snapshots recalculate this order. Top-level Goal
ordering remains independent. Other starting tasks in a merge are included,
while external prerequisite context is excluded. The list retains all five
statuses; filters determine whole-chain visibility and never remove children.
Child rows show their own status, applicable ready/blocked markers and known
execution duration after the title, and open the shared task dialog. Cancelled
records retain their original execution interval; cancelledAt never substitutes
for a missing execution endpoint. The expanded heading offers the representative
task's own details. Aggregate progress still includes that representative.
Chain rows aggregate only component members: all done means done; all cancelled
means cancelled; mixed terminal results mean ended. An unfinished chain with any
terminal or in-progress member means in progress; otherwise it means todo.
A terminal representative with unfinished members stays visible. External
prerequisite context does not contribute to chain progress or status. The former
shared-membership badge is removed: a task can recur as context while its actual
component membership remains unique.

Both categories share assignee and status filters and the current
task-list page position; category switching does not restore an older offset. Chain
ordering uses its representative's exact `(created_at,id)` service order,
reversed for newest first without lossy JavaScript timestamp conversion. The
open graph dialog keeps an active actual-task witness for the current reading
session and resolves its component from the complete index after merges or splits
without overwriting a valid witness with a new representative. A valid graph
requires a multi-member component and the active Task list / Task chains view;
list filters and pagination do not affect its validity. A removed or standalone
witness closes the dialog. Membership changes initialize a new bounded overview
and framing without remounting a same-representative canvas or active Details.
A representative change initializes the newly represented graph within the
current dialog. Ordinary status and clock refreshes retain visible S, viewport
and inspection under normal reconciliation.
The [task view decision](../../.agents/notes/archived/feature/2026-10-22-project-task-views.md)
and [chain status decision](../../.agents/notes/archived/bug-fix/2026-10-22-task-chain-status.md)
record their current rules and original rationale.

The runtime accepts proposed, todo, in_progress, done and cancelled. The graph summary
has eight counts: total, proposed, todo, inProgress, done, cancelled, ready and blocked.
They satisfy `total = proposed + todo + inProgress + done + cancelled` and
`todo = ready + blocked`. Creation defaults to proposed and accepts explicit todo for confirmed work. Proposed is unfinished, never ready and does not satisfy dependencies. All-proposed Goals aggregate as proposed; unstarted proposed/todo mixtures aggregate as todo. All-done Goals have the done
aggregate outcome, all-cancelled Goals have cancelled, and mixed terminal Goals
have the UI-only ended outcome. Ended is not a TaskStatus. Progress counts
done + cancelled while preserving each result count. External context does not
affect progress.

The actual task title is the common dialog header and accessible name, with a
copy icon immediately to its right. The ID and its copy control belong to Overview.
The five-state submission menu for non-cancelled tasks begins the shared state row beside the assignee
control, followed by platform and readiness, with automatic execution at the right.
Status, assignee and platform controls share a compact 24px height; the left group can wrap
on narrow screens. The menu remains available on every content tab, marks the current
item and permits selecting it for the original states. Cancelled records have a
distinct readable status and no reopen, resume or withdraw action. The cancelled
target uses the existing state confirmation with Confirm cancellation / 确认取消,
describing irreversibility, retained readability, preserved execution times and
dependency satisfaction. Active claims mark the option aria-disabled and show the
release reason on hover or keyboard focus without dispatching a request; no remote
stop action or reason form is added. Arrow/Home/End, activation and
Escape preserve keyboard access and focus. Confirmation shows the full task name,
current/target states and timing consequences. Cancel is initially focused;
Cancel/close/Escape submits nothing. Long title and confirmation text have bounded
native scrolling; 320px retains controls without horizontal page overflow.

Status, allowAgents, requiredPlatform and assignedTo saves share one per-task
mutation owner. Operations that require confirmation share one confirmation union.
Reviewed identity/status/version and material inputs remain frozen; observed
changes invalidate confirmation. Exact bigint version survives JSON numeric
serialization without rounding. Same-state requires +0; actual change requires +1.
Same-state may return fresh derived readiness at the same version. Actual
cancellation requires a non-null cancelledAt while preserving startedAt,
completedAt and all other materials. Its result uses ordinary status installation,
not the deletion path; malformed results reconcile through GET without replay.
Generation and
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
owns server rules, migration and timing. Server module tests cover HTTP,
database and persistence behavior.

Task details share claim display and force withdrawal across the dialog,
standalone page and fullscreen. Active claims show the user, machine, agent and
phase; completed history and a missing worker are not a current claim. Project
participant profiles supply nullable names and email addresses,
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
the original owner or a project admin sees **Force withdraw** for active
ownership; the service rechecks membership and authority.

Withdrawal confirmation freezes the task, claim and precise version. It explains
that the task returns to `todo`, worker ownership and execution timing are cleared,
and automatic execution is disabled. The remote agent may continue until its
worker synchronizes and cleans up; immediate stopping is not guaranteed. Cancel
submits nothing. The shared TaskDetailSession serializes the operation, validates
the returned reset while preserving other materials and refreshes the graph.
Conflicts require a fresh review; uncertain outcomes use GET-only reconciliation
without replay. This action does not require the original worker to be online.

Both lists apply the shared status priority before exact newest creation order,
with descending IDs breaking equal-time ties. Updates do not move an entry
unless its sorting status changes. Both categories default to all statuses and
include historical done and cancelled tasks. Assignee and status filters control
whole entries, while expanded child lists retain every ordinary member. Each
category shows visible/total counts and distinguishes an empty category, no
matching entries and a truly empty project. Long titles grow naturally in compact native
controls. Goal headers retain 7px row gaps and responsive progress widths; the
graph action can wrap on narrow screens. Desktop header titles stay 13px and
narrow-screen titles 12px. Child tasks use compact rows with visible individual
status.

Each mounted ordinary chain representative row owns an initially collapsed disclosure
state, separate from graph opening. Several lists can be expanded at once. Same-row refreshes
and detail/graph round trips preserve that choice while updating current
members. Inactive inner categories unmount their rows, and filtering or
representative replacement can also remove a row; remounting starts collapsed.
Outer Overview switching retains the visited task subtree and its disclosure
choices. No disclosure state is stored in browser preferences. The [Goal-list
decision](../../.agents/notes/archived/feature/2026-10-26-goal-task-lists.md) records the rationale for this interaction.

The typed Goal category also expands each Goal in place. On desktop its header
matches the task-chain header height for equivalent unwrapped content in the
same font; wrapped content grows naturally, including on narrow screens. The header
body toggles a flat list of all direct ordinary children. Separate Goal details
and graph buttons open their readers without changing the disclosure. The Goal
disclosure starts closed. The card owns its rounded outline and clips its contents;
the heading meets the neutral expanded area at a single divider, and the final
visible child meets the inner bottom edge without the shared chain-list padding.
Empty states retain their padding, child rows use their own status colors, and
completion-time popovers escape the clipping boundary. Scoped progress counts
only its own members, including separate done and cancelled results. The header shows a localized
in-progress count of direct children, including zero and paused or manually
executed tasks. It also shows the shared automatic execution indicator after the
assignee when any direct child has an active Worker claim. Permission alone,
Session activity and claims outside the Goal do not trigger it. Both summaries
use the existing project snapshot, remain readable when collapsed, and update
with status, claim and Parent changes without extra requests. List filters and 20-item pagination
apply to Goals themselves, not their children. Graph and Task readers preserve
the original Goal source, background list state and focus fallback.

In-progress Goal children can open their current accessible Session directly.
Small working, notice and warning text annotations share the complete `sessions`
map from the existing visible-page fifteen-second task-sync. Reliable pending
Sessions retain the same shortcut without an annotation. Child status controls
open that Task's Session tab; titles still open Overview. Chain and Goal status controls
only expand members. Collapsed chains and assignee-filtered chains include every
ordinary member, including the root; external chains do not contribute. A Goal
heading aggregates every direct ordinary child once, independently of disclosure
and child Tag filtering. It uses warning > notice > working and hides the annotation
and aggregate action when none is displayable. The Goal's lifecycle status and
background remain its own; its active-claim indicator has separate meaning.
Visible Goal containers register the full child scope with the same store, including
when collapsed, and release observation through the existing visibility lifecycle.

`useTaskGraph` owns one page-local summary store and is its only producer, passing
it through ProjectPage, ProjectTaskWorkspace and the presentation Provider. List
visibility and disclosure issue no Current requests. Each state and omission
requires the response's observed execution binding to match the current accepted
Task; final cache merging cannot attach an old observation to a newer claim.
The thirty-second lifetime starts at the API body receipt and survives decoding
or storage waits. Publication and visibility restoration recheck that deadline;
ordinary polling waits retain unexpired states, while current failures, auth pause
and binding/scope loss retract them. The existing auth pause revision captured
before HTTP must still match after cache waits; resuming admission cannot let a
pre-pause response republish retracted contributions. This Session gate preserves
the normal Task graph pipeline and authentication shell. Other cache producers and tabs can invalidate
old bindings but cannot publish or renew this page's Session observations.

Session state remains in memory and never changes Task properties, business
versions, timestamps, IndexedDB or BroadcastChannel. Its notifications reach only
its consumers, without detail invalidation, ordinary Task notifications or extra
graph work. The [Session status design](../../docs/design/task-session-status.md)
owns admission, precedence, expiry, visibility and stable annotation geometry;
the [TaskSync design](../../docs/design/daynight-task-sync.md) owns request and
cache responsibilities.

The explicit View dependencies / 查看依赖关系 action opens one centered
dependency-graph dialog at a time without changing any disclosure state.
The toolbar selects horizontal or vertical direction and remembers it locally per
project and representative task, defaulting to horizontal. Read, invalid-value
and write failures are visible while direction changes remain usable. Switching
preserves visible tasks and inspection, and reframes the current graph. Desktop
geometry is `80vw × 80dvh`; at widths of 740px or less the dialog fills
the viewport except for 12px gutters. The title shows the chain name, status
and progress. Closing with the explicit button, backdrop or Escape restores the
original graph button without changing status/assignee filters, pagination, list
rows, expanded children, list height or scroll. The original opener and original
list task witness remain unchanged across external Goal hops. If the opener
disappears, close resolves that original task to its current visible Goal, then
uses the first visible Goal disclosure, list region or active category tab.
Complete P contains every ordinary component member and its directly declared
external prerequisites, deduplicated by task ID. Context ancestry and unrelated
successors do not enter P. Main
progress counts component members only, and project counters count each project
task once. Actual visible S is progressive within P; ordinary members have bounded direction
controls and external cards have an independent resource-navigation action.
Dashed edges encode explicit external dependencies, including a shortcut inside
one ordinary component; dashed cards encode context outside that component.
Ordinary context edges stay solid. Details labels prerequisites, blockers and
successors using each edge's own marker; no dependency editor is added.

P with at most fifty tasks and one hundred dependencies is fully visible.
Larger P starts at the representative with stable undirected BFS, successors before prerequisites
in snapshot order; accept a task only when the complete induced graph remains
within fifty/one hundred, and traverse only accepted tasks. Ordinary member cards expose direction
controls adding at most twenty hidden direct neighbors in P, with exact new-task,
new-induced-edge and remaining counts. Manual expansion has no edge cap. Every
real edge with both endpoints in S appears, without shortcuts or aggregate cards.

Ordinary member cards are 220 by 96 pixels without hidden direct neighbors, using a 94px body
and two border pixels with no footer or separator. Cards with expansion controls
are 220 by 136, including a 40px two-column footer; an unused direction retains
its column. External cards remain 220 by 136 with an independent Expand footer.
Each visible snapshot derives expansion data once. Layout, React
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
[progressive decision](../../.agents/notes/archived/feature/2026-10-22-progressive-task-graph.md)
separates topology state from presentation lifetime.

Per-project browser preferences retain the selected outer section and inner task
category and one shared task-list page offset. Graph direction is saved per project
and representative task. Filters, graph dialog opening, witness, Goal disclosure,
fullscreen, details and graph viewport are temporary;
the former `daynight:project-view:${projectId}` expansion record is not read or
written. The outer section uses the independent
`daynight:project-section:${projectId}` record with the JSON string `"overview"`
or `"tasks"`, `"prs"` or `"tags"`; a missing record selects Overview. A read or format failure selects
Overview with a section-specific notice; a write failure retains the current
in-memory selection and reports that it was not saved. Other preference errors
likewise leave the current page usable with visible feedback.

The Tags section is available to project members and administrators through the
project access boundary. It reads one in-memory catalog page for the current
identity, project and query, and offers search, creation, rename and deletion.
Names are trimmed and validated as 1–64 Unicode code points without controls or
line separators; the server enforces ASCII case-insensitive uniqueness. A delete
preview reads the current tag, original version and visible Task and Goal counts.
Confirmation removes every association, including those added after the preview;
counts are hints rather than a condition on deletion. Writes retain the observed
version. Conflicts and unknown outcomes retain the draft and require a current
observation; a check does not replay a write or establish the original outcome.

Catalog cursors bind the project, principal, query, limit and catalog epoch.
An invalidated cursor restarts at the first page; background revalidation retains
the displayed page and drafts while waiting. Counts are refreshed independently
of the epoch, which tracks names, membership and ordering. The catalog is not
persisted or accumulated in the Task cache. Batch resolution validates selected
IDs outside the current page. Leaving the section cancels its reads; an
already dispatched write is retained as unknown for review on return. Identity
or project access withdrawal retires private data and requests.

Task and Goal details share a searchable multi-select tag editor. Its draft starts
from the resource's own detail and keeps its original version until the user
explicitly adopts a newer one. Saving replaces the complete association set,
including an empty set. Conflicts and unknown outcomes retain the draft and
show the current saved or last observed tags without replaying the write. An
observed empty set is explicit in reconciliation, while ordinary empty tag
displays occupy no space. Read errors and unknown outcomes remain visible.
Creating a tag in the picker writes to the catalog independently; cancelling the association edit
does not delete it. Pending saves retain later local edits. Identity change or
project access withdrawal retires private editing state.

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
[shared-scroll decision](../../.agents/notes/archived/bug-fix/2026-11-03-shared-task-list-scroll.md) records the rationale for the shared offset and category-switch behavior.

The generic task and summary decoders require type, nullable parentId and
assignedTo, and a properties object, preserving all property keys. Graph decoders
require type and parentId and accept ordinary Tasks only.
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
membership uses ordinary-edge weak components. A chain projection contains all
ordinary members plus their direct external prerequisites, deduplicated by task
ID, and all real edges whose endpoints are in that projection. It does not follow
ordinary or external ancestry from contextual tasks. Complete prerequisite
inspection still uses the project index and counts hidden ancestors beyond this
one-hop projection. Relationship labels and dashed edges use the persisted
marker independently of outside-component card context.
The complete model is specified in the
[external dependency design](../../docs/design/daynight-external-dependencies.md).

While a project remains mounted and the browser permits execution, task-sync runs
every fifteen seconds when the document is visible and every five minutes when
hidden. Visibility transitions reset the interval from the transition; hiding
does not request or cancel a read, and returning attempts a read immediately.
Focus alone does not change the interval. Browser throttling or freezing makes
the background interval nominal. Automatic ticks and visibility recovery skip
active syncs.
Manual refresh cancels the active read and starts immediately. Every successful
response updates the mount's clock receipt, including duplicate-only responses.
Detail content follows its own summary business version and project generation;
unchanged receipts do not cause GETs or detail writes. Receipt-driven recovery
still retries failed reads and raw graph disagreements. `GraphSnapshot.revision`
is zero for local-only summaries; positive values are the successful mount-local
receipt and online-admission signal, not a task version or durable commit counter. Equivalent
task data and dependency states retain their index and layout; settings-only
changes update Project metadata without rebuilding task projections. Changes
to intrinsic data or dependency states replace the affected projection and
statistics together. The
[automatic refresh decision](../../.agents/notes/archived/feature/2026-10-22-project-task-auto-refresh.md)
records the rationale for the scheduling and scope.

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
[detail refresh decision](../../.agents/notes/archived/bug-fix/2026-10-23-quiet-task-detail-refresh.md) records the rationale for quiet polling; the
[notification decision](../../.agents/notes/archived/bug-fix/2026-10-24-task-detail-notifications.md) records the rationale for layout-independent feedback and recovery. Project and task changes release
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
decision](../../.agents/notes/archived/feature/2026-10-26-task-chain-graph-dialog.md) records the rationale for graph presentation and preserves the original [fullscreen
rationale](../../.agents/notes/archived/feature/2026-10-22-task-graph-fullscreen.md).
Each node has sibling native inspection, Details and expansion controls.
Ordinary members retain progressive direction controls. An external card has an
Expand button that opens its ordinary-component Goal graph, or closes the origin
graph and opens the existing task reader for a standalone task. Goal navigation
resolves the actual task through the complete component index and directly updates
the graph witness, using the destination Goal's own direction. A filtered or
off-page destination can open while status/assignee filters, page, rows, expanded
children and scroll remain unchanged throughout navigation and after close.
Repeated Goal hops retain the original list opener and original list witness for
focus restoration. Overview positioning alone adjusts obscuring filters and the
destination list page. External ancestry is not added to the origin canvas. A long
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
[fullscreen-reading decision](../../.agents/notes/archived/feature/2026-10-25-task-detail-fullscreen.md)
records mode, scroll and keyboard ownership.

## Markdown task descriptions

Task descriptions render CommonMark and GFM using the same `MarkdownContent`
renderer and styles as Markdown attachments: headings, paragraphs, lists,
checkboxes, quotes, fenced code, tables, links and images. Mermaid fences render
static diagrams under the
[shared diagram requirements](../../docs/spec/daynight-task-inspection.md#markdown-图表).
Raw HTML remains text;
URL protocols retain the renderer's existing policy. Empty descriptions use the
current interface language. Markdown and localized messages do not change the
stored string or CLI/API output. Wide tables and code scroll within their local
regions, and long words wrap inside the Overview reading column at 320px.
Nonempty Task and Goal descriptions have the same bordered reading container in
page, dialog and fullscreen modes; empty descriptions, Steps and attachments keep
their existing presentation.

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

Mermaid 12.2.0 loads on demand for `mermaid` fenced blocks. The reader supports
15 stable types: flowchart (`flowchart`, `graph`, `flowchart-elk`), sequence,
class, state, ER, Gantt, journey, pie, quadrant, requirement, XY, block,
packet, kanban and event modeling. Experimental types and third-party plugins
are not accepted. Each block keeps independent loading/error feedback and
inspectable source. A source may contain at most 50,000 UTF-16 code units;
per-type structural budgets limit each counted category to 500. Block expansion
is checked before parsing; before rendering, its actual tree is also limited to
50,000 estimated SDK sizing calls. A deeply nested block can exceed this budget
even with fewer than 500 nodes. A pinned SDK patch limits Gantt calendar work to
50,000 actual steps per task compilation. The
[diagram design](../../docs/design/daynight-task-inspection.md#mermaid-图表)
owns the counts and implementation constraints.

The pinned parser identifies image nodes before drawing, including escaped
metadata keys. A refused image node cannot occupy the rendering queue; ordinary
shape metadata and literal `@{` labels retain their meaning. Supporting image
nodes requires an interruptible isolated renderer; a timeout alone cannot
interrupt Mermaid's internal image decoding. Successful diagrams are inert SVG
images with intrinsic dimensions derived from their viewBox. Directives and
frontmatter cannot override application security or theme. Custom style resources
and ordinary Markdown images retain normal browser resource behavior, so diagram
rendering is not network-isolated. Wide diagrams scroll in a focusable local
region at 320px. Source changes and unmount invalidate obsolete results and
release owned rendering resources.

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
[split-view decision](../../.agents/notes/archived/architecture/2026-10-22-task-attachment-split-view.md) records the rationale for this composition and its scroll rules.

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
The [directory-disclosure decision](../../.agents/notes/archived/feature/2026-10-25-attachment-directory-disclosure.md) records the rationale for the separation between selection and navigation reveal.

The upload section starts collapsed. Activate Upload with a click or the
keyboard to expand it, then select one local file, accept its name as the initial
target or edit the relative path, and upload. Activating the disclosure again
collapses it while retaining the file, path and validation state. Tab round trips
retain its expansion; a new project/task starts collapsed. MIME is selected
from the target path with `mime` 4.1.1. Uploading the same path overwrites that file. Each preview offers Download,
a neighboring Open in new tab link with an external-link icon. Each left-side file row has a right-side `…` menu. Choose Delete to open a full-path confirmation, then explicitly confirm to submit the single-file request. Cancel is initially focused; menu and confirmation Escape close only their own layer. Pending confirmation blocks duplicate/conflicting writes, while failures remain visible with deliberate retry or cancellation. The confirmation uses the current locale without its own language selector or preference feedback; existing page controls and feedback remain in their existing locations. Hidden tabs dismiss unsubmitted deletion UI. Successful writes refresh only attachment data.
They do not change the task version, timestamp or graph snapshot.

The attachment hook owns list, write, selection and preview state for one
project/task identity. It follows all pages, keeps already-read files when a
later page fails and labels the result incomplete with a retry action. Scope
changes and unmount cancel requests; generations discard late results. List,
write and preview errors stay local. An overwrite or a refreshed `updatedAt`
reloads the selected content and remounts native previews; the server's
`Cache-Control: no-store` keeps mutable paths current. Empty inventory and no
selection have distinct states; deleting the selected file clears its preview, while deleting another file preserves the loaded preview and reading position. A failed delete retains the last-known row and preview without promising server-side rollback under K1.

The shared Task and Goal preview header displays the selected attachment's created
and last-modified timestamps using the current locale and browser time zone, with
seconds and semantic `time` values. It retains known metadata during refresh,
preview errors and remote-operation pauses; confirmed removal or absence clears it.
On desktop, file information sizes to content up to 240px, followed by timestamps with a 16px gap and right-aligned actions. Both timestamp values share a left edge. Narrow screens wrap the groups; compact short screens retain aligned timestamps and accessible actions.

The right preview has one vertical scroll owner. Markdown, text/JSON/source and
large images use `attachment-preview-body`; their renderers have no nested
vertical height limits. Tables and code can scroll horizontally. For ready
HTML/PDF, the body and fitted frame wrapper hide overflow and the embedded
document or native reader owns scrolling. The preview header never scrolls
independently, exposes the complete path and keeps Download and Open in new tab reachable. File-row menus and confirmation controls remain accessible at narrow widths.
Left-pane scrolling does not move right-side content or its reading position.
The standalone complete details reuse this panel, rendering and sizing; their
outer composition integrates task, tab and file navigation with URL and history.

Markdown uses `react-markdown` 10.1.0 with `remark-gfm` 4.0.1 for CommonMark and GFM
including tables, plus the shared static Mermaid diagrams described above.
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
and page: description, status, relationships, PRs, metadata, five-state setting,
automatic-execution permission, execution platform, assignee and attachment management.
`TaskDetailDialog` supplies the modal portal. `DetailFrame` and its overlay hook
share the focus loop, counted scroll lock, fullscreen scroll restoration and
kept-mounted slots. Explicit parent ownership follows React across portals;
child layers hold inert leases on their parent and alone handle detail Escape/Tab.
Focus restoration remains with the opening workspace. `TaskDetailPage` provides an ordinary full-page container,
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
an `AttachmentKeyboardOwner` with the active reading root, layer eligibility and `onEscape`; the
already-loaded same-origin frame updates its listeners without reloading. The
bridge adds a final Window handler for each Escape/Tab event after the child
application's current Window consumers, so consumed shortcuts retain precedence
while boundary Tab remains synchronous. Abortable cleanup also works after the
frame navigates cross-origin. Exiting releases the standalone bridge; ordinary page
Escape does not navigate or close the window. Native PDF readers may not expose
a controllable document: HTML keyboard proof does not establish PDF key behavior,
and explicit exit/return controls remain available.

`/projects/{projectId}/tasks/{taskId}` defaults to Overview for ordinary Tasks and
Description for Goals. The existing
`/projects/{projectId}/tasks/{taskId}/attachments/{path...}` defaults to
Attachments with that exact file selected.
`tab=overview|description|attachments|steps|discussion|session` enters shared
navigation. A Goal presents Description, Attachments and Discussion in that
order, with `description` and `overview` selecting Description. Its child tasks
and scoped chains remain in the project Goal list. Description uses the Goal's
Markdown and attachment owner and shows the existing empty state when empty.
Its information aside starts General information with the complete, selectable
Goal ID and a localized copy button. Copy uses the shared Task clipboard button
and a notification host owned by the Goal frame: pending disables repeated
submission, success confirms the copy, and rejection or unavailable clipboard
access shows a Goal-specific error while preserving manual selection and retry.
Results arriving after resource replacement or unmount cannot notify a new Goal.
Copy remains available for any readable Goal, independently of edit permission,
status, empty children or graph loading and failure; existing unavailable-resource
boundaries still apply. The UUID wraps without horizontal overflow at 320px and
390px, and the copy button remains reachable. The aside also displays the Goal's
creation and modification times in the selected language and browser timezone,
together with direct-child standalone, chain, total, done, cancelled and unfinished
counts. Classification uses the
complete ordinary graph before Parent projection; external edges do not merge
chains. The description scroll owner contains both desktop columns, stacked on
narrow screens. Unknown graph state is distinct from zero tasks, and a failed
refresh retains displayed counts with retry. The three panels remain mounted
across tab changes, refreshes and fullscreen transitions. Ordinary Tasks do not
have a Description tab and fall back to Overview for `tab=description`; Session
falls back to Overview when no Session panel is available. With no file selected, Attachments uses the base task
URL with `?tab=attachments`; a hidden file selection can remain in an attachment
path with `?tab=overview`. `taskDetailUrl` builds those URLs from
`TaskDetailNavigation`. The app observes both pathname and search, and login
return navigation retains navigation query parameters so authentication does not
lose the tab. The login-start target removes transient `authError` feedback,
preventing an old login failure from surviving a successful return.

Standalone relationship navigation, tab changes, file selection and successful
upload selection synchronize the address and add history only for a new state.
Back/Forward apply the address state without adding an entry. Goal graphs, child
Task dialogs and external Goal dialogs on a standalone resource page also restore
their reading selections with Back/Forward without changing the root URL.
A cross-Goal Details destination selects its Goal and child Task together.
External Expand selects the Goal and complete chain graph for a multi-member
destination, or opens Task details for a single member. From a standalone reader,
unparented chain Expand carries its witness through the project URL
`#chain={taskId}`. The project consumes and clears that transient fragment once
its complete index is available; `#task={taskId}` retains task reading and list
location semantics. Invalid or missing targets use existing unavailable feedback.
These fragments do not add persistent preferences or nested detail URL state.
Closing a layer replaces the current selection after draft admission. Project-page
sections, graph, details and their nested reading selections also participate in
Back/Forward without changing the project URL. Traversal does not replay operations
or save preferences; closing replaces the current selection with its parent.
For standalone URLs, copying or reloading restores the root task, tab
and file; nested selections do not carry resource data or drafts. A same-task
tab/file route change keeps the shared surface and attachment controller mounted, retaining directory
disclosure, sidebar scroll and upload drafts. Task and authenticated-identity
changes preserve the existing cancellation and state-isolation rules.

The page opens its complete Task through a direct live observation. A separate local task-chain graph supplies available relation titles and ordinary successors; graph failure does not block the rest of the detail. External successors may lie outside that projection. Each window reads its own resources and opening, with no Task objects or confirmations transferred from the opener. Visible direct details refresh every fifteen seconds and pause while hidden. A successful write remains confirmed but cannot enable another write until a fresh Task observation reaches its committed version; failed refreshes remain visible and retryable without replay. Account-change waiting retains existing page interaction, while history or access retirement unmounts the reading resources.

The [inspection requirements](../../docs/spec/daynight-task-inspection.md#独立完整任务详情),
[design](../../docs/design/daynight-task-inspection.md#独立完整任务详情) own
complete-page behavior and composition. The
[standalone-detail decision](../../.agents/notes/archived/architecture/2026-10-24-standalone-task-detail.md)
records the original trade-offs.

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
is introduced. The [full-reader decision](../../.agents/notes/archived/architecture/2026-10-22-task-attachment-full-reader.md)
retains routing/rendering foundations and the
[shared-page decision](../../.agents/notes/archived/architecture/2026-10-24-shared-attachment-page.md)
retains full attachment-panel reuse rationale. The standalone-detail decision
records the original complete Task Detail composition choices.

## Validation and build

```bash
pnpm web:typecheck
pnpm web:build
pnpm web:test
pnpm web:test:browser
```

The build uses `tsconfig.build.json` to typecheck application sources, the Vite
configuration and their imports, then emits production HTML and hashed assets to
`packages/daynight-web/dist/`. `pnpm web:typecheck` uses the full `tsconfig.json`
to check application sources, tests, scripts and tool configurations. Production
compilation does not require test or acceptance fixtures from other modules.
`scripts/publish-assets.mts` validates the index,
its local asset references and ordinary files, prepares a complete staged copy,
and replaces `packages/daynight-server/internal/service/webui/dist/`. Failed validation
or publication fails the build; a failed swap attempts to restore previous assets
and reports both causes if rollback also fails.
The Go binary embeds the published output. Both generated directories are ignored
by Git, and clean production server builds require this explicit build first.
The Go module check uses its own unit-test Web resource overlay; see the
[server validation guide](../daynight-server/README.md#validate).
The existing root `build`, `test` and `acceptance` commands retain their CLI scope.

`web:test` serially composes two required package commands. `test:harness` runs
its Node tooling tests, including the coverage checker and asset publication.
`scripts/ci.mts quality` runs full-workspace Web typechecking, the tooling suite,
the real localhost Dockerfile's `web` target, Vitest coverage with four workers,
and the statement checker with respective process limits of 1, 3, 5, 15 and 1
minutes. Each limit includes process startup, reporting and exit. The Docker
stage requires a Linux Docker engine and registry access; it verifies container
installation, production compilation and asset publication using the actual
build context. It starts no service or database and does not run Go validation.
Vitest suppresses console output from passing tests, including diagnostics from
expected failure scenarios, and retains console output from failing tests.
`test:coverage` runs the ordinary Vitest suite with V8 coverage and then the exact statement gate. Full-scale graph,
model, geometry and original-image byte workloads live in `.stress.ts` files and run only through
`pnpm test:stress` from this package (`pnpm web:test:stress` from the repository
root). Its dedicated `vitest.stress.config.ts` refuses CI; ordinary discovery
excludes those files while retaining compact correctness and boundary cases. Either command can be
run directly with `pnpm --filter @codetreker/daynight-web test:harness` or
`pnpm --filter @codetreker/daynight-web test:coverage`; `pnpm web:test` remains the
unit and tooling gate. `pnpm web:test:browser` separately runs every module
browser configuration serially, each with its own Vite host and controlled API
fixture. Install Playwright Chromium first; a failed or cancelled suite fails the
command. The runner requests Playwright cleanup, checks its own preview processes
and isolated browser profiles, and reports cleanup failures. If a forced stop
leaves ownership uncertain, the command fails without claiming cleanup. Windows
uses its process-tree terminator; orphaned browsers whose identity cannot be
verified are reported rather than terminated.

The Session draft browser fixture uses the production composer, Session client,
image store and IndexedDB draft storage with controlled HTTP/WebSocket responses.
It checks Blob restoration after refresh and tab closure, native cross-tab locks
and conflicts, input ordering, undo, preview focus, and reconciliation of unknown
sends. Its ordinary configuration runs through `web:test:browser` and the Web
browser CI job. The 8/9-image and 10/20 MiB capacity cases run separately from this
package and refuse CI:

```bash
pnpm exec playwright test --config tests/navigation/session-drafts-stress.config.ts
```

Set `DAYNIGHT_BROWSER_CHANNEL=chrome` to use an installed Chrome. Ordinary results
are written to `.tmp/session-drafts-browser/`; capacity results use
`.tmp/session-drafts-capacity/`. These tests prove browser behavior with controlled
API results, without establishing live Worker or Provider image support.

The attachment and task-reading fixtures exercise native frames, relative HTML
resources, PDF page pixels, selection, focus and narrow reading layouts. Graph
fixtures check rendered dependency geometry and retained viewports. Step and task
controls exercise browser history, keyboard focus and short viewport menus. These
controlled responses establish frontend behavior; they cannot establish a server
commit or authorization decision. All `src/**/*.ts` and `src/**/*.tsx` files belong
to the product manifest, including the browser entry. Tests live outside `src`.
The checker independently compares that manifest against `statementMap` and `s`
in `.tmp/coverage/coverage-final.json`; missing runtime files fail even when they
were never imported by a test. Empty, malformed and incomplete reports fail.

The Project settings route-retention suite exercises dispatched saves through
`AuthenticatedApp` navigation, including request survival, the confirmed
receipt and return-read ordering. Form tests separately cover localized feedback,
exact version serialization and cancellation before dispatch. The
[project checks decision](../../.agents/notes/implemented/bug-fix/2026-11-05-stable-project-checks.md)
records the ownership trade-off.

Status, platform and automatic-permission API tests distinguish strict decoder
inputs, target-specific write confirmation and shared transport failures. Complete
detail/graph malformed-field matrices retain their input boundaries; representative
HTTP cases check decoder admission and protocol classification. The
[API proof decision](../../.agents/notes/implemented/testing/2026-11-06-web-api-proof-owners.md)
owns that separation and its limits.

State-only waits in the platform, pause, status, assignment,
direct-observation and Steps session suites use `tests/helpers/waitForState.ts`.
It delegates to Testing Library with a 5ms default polling interval, preserving
immediate checks, timeouts, errors and explicit options. The mixed Steps session
suite retains Testing Library's default wait for DOM predicates. Production
polling remains unchanged.

Readiness must describe the operation being observed. Retired Step parent-check
tests settle the reopened parent and Steps collection before arming their fault
responses. Steps history-replacement tests flush pending React work, then jointly
require fresh parent and Steps versions, the rendered row and the retained draft.
The [direct-observation state-wait decision](../../.agents/notes/implemented/testing/2026-11-07-direct-observation-state-waits.md)
and [Steps session state-wait decision](../../.agents/notes/implemented/testing/2026-11-07-steps-session-state-waits.md)
record these readiness and reader-lifetime requirements.

Catalogue-only direct-observation cases mount the real detail hook, session and
cache without the detail surface. They bind injected cache verification outcomes
to the catalogue request signal. Menu, relation, focus and confirmation cases
retain the full surface. The [catalogue fixture decision](../../.agents/notes/implemented/testing/2026-11-07-direct-catalogue-fixture.md)
records the ownership and isolation trade-off.

Status and attachment continuity cases that do not exercise graph presentation
open the child through the real expanded chain row. Graph state, graph failures,
obsolete responses and App route isolation retain their original entry paths.
The [status entry decision](../../.agents/notes/implemented/testing/2026-11-07-status-chain-entry.md)
records the test ownership.

Authenticated-shell and Team-navigation integration tests use the state waiter
for request counters, request bodies and storage observations. Rendered controls
and mixed state/presentation predicates retain the DOM waiter. Identity-mismatch
fixtures observe actual cache commits, sync-principal inspection and recovery
request dispatch before checking presentation; they do not substitute timer
advancement for IndexedDB or React completion. A later task opening must admit
its live read before a held write is settled, while the independent retired
write still keeps controls locked. Status completion checks sample matching
cache and live versions before querying the actual status picker within one DOM
readiness bound. Stable navigation phases query the current
owner and retain visibility, identity, ordering and duplicate-control checks.
The [identity observation decision](../../.agents/notes/implemented/testing/2026-11-07-identity-test-observation-boundaries.md)
records these boundaries and their limits.

Project-settings route-retention and management tests use the same state waiter
for request dispatch, mocked callbacks and abort signals. Responses, cache
admission and presentation retain independent checks; a dispatch count does not
prove that a result was admitted. OAuth revocation tests hold the write and
current-state read separately, retain the busy dialog and active row while the
read is pending, and assert no premature success. The read resolves within React
`act` so the revoked state, dialog teardown and passive heading-focus restoration
settle before their completion assertions. Settings actions, token creation fields
and member role controls use their current panel, form or roster. Readiness helpers
click the same enabled button returned by their semantic query. Global privacy,
absence and duplicate-control assertions retain document-wide scope. The
[settings and management observation decision](../../.agents/notes/implemented/testing/2026-11-07-settings-management-test-observations.md)
records these query and waiting boundaries.

Webhook page tests independently observe request preparation, dispatch and the
resulting UI. Native SHA-256 preparation is held by explicit promise gates in the
restrictive cleanup case; each release retains the real digest computation.
Exact write counts and distinct operation IDs identify sequential mutations.
The personal-page mount waits for its initial detail request and releases the
response within async React `act` before returning; initial list failures and
empty lists keep their separate readiness predicates. Team selection waits for
its current named option, and the shared Team-selection helper also settles its
initial detail response within async `act`. Endpoint effects therefore settle
before secret reads and subsequent responsive or Back interactions. Controlled
management and receipt responses settle within React `act` before authorization,
draft, secret, original-operation and no-replay assertions. Late-denial tests complete the newer
Team membership refresh or owner selection before releasing the old response.
Rotation confirmation waits for dialog removal and an enabled Check operation
action. Rendered errors, secrets, dialogs and focus use DOM readiness predicates;
cached owner-role labels, fresh detail controls and list error removal remain
separate observations. The [Webhook observation decision](../../.agents/notes/implemented/testing/2026-11-08-webhook-observation-boundaries.md)
records the retained fixtures and the limits of these frontend checks.

Step panel DOM tests retain the full pagination fixtures and resolve visible
controls by role and accessible name within their current row, form, toolbar,
pagination or confirmation dialog. Whole-page counts retain document-wide scope.
The [query ownership decision](../../.agents/notes/implemented/testing/2026-11-05-step-panel-query-owners.md)
records the retained accessibility, draft and focus proof and its cost boundary.

Project browsing and graph tests resolve tablists, filters, pagination,
search, dialog headers and graph viewport actions within their current owners.
Global absence, privacy and node/edge/page counts remain document-wide.
Unchanged refresh receipts and repeated search errors are observed through the
actual controller/UI publication before interaction. The full graph expansion
and keyboard fixtures remain intact; the [project/graph query decision](../../.agents/notes/implemented/testing/2026-11-07-project-graph-query-owners.md)
owns those query and receipt boundaries.

The task controls browser suite exercises the project pause list using native
popover behavior, including keyboard and focus restoration, history, dynamic
snapshot updates and narrow viewports. Run `pnpm --filter
@codetreker/daynight-web exec playwright test --config
tests/navigation/task-controls-playwright.config.ts` after installing Chromium.

The focused navigation browser suite builds a minimal editor host from the
production router, admitted-location owner and task confirmation. It checks draft
admission independently of Steps forms and HTTP writes, including indexed
history traversal, retirement, beforeunload, keyboard focus and both languages at
320px. Run `pnpm --filter @codetreker/daynight-web exec playwright test --config
tests/navigation/playwright.config.ts` after installing Chromium. Results and
failure captures are written to
`packages/daynight-web/.tmp/acceptance/navigation-contract/`.

The Team navigation browser suite builds one production application preview for
four Playwright projects: `team-preference` covers Team selection, Worker
configuration identity, and prompt editing across background checks, history and
narrow layouts, `team-management` covers settings and rename interactions,
`team-members` covers membership and self-exit, and `session-record-layout` covers
responsive execution-record selection, keyboard and touch input, history loading,
errors and pagination. Each case owns its browser
context and controlled API responses; the preview serves only static assets.
Run `pnpm --filter @codetreker/daynight-web exec playwright test --config
tests/navigation/team-playwright.config.ts`; add `--project team-management` to
focus on settings geometry, wrapping, text selection and rename interactions.
These module browser fixtures use one worker and zero retries. Preference and
Session layout cases use 45-second deadlines, management and members use 30
seconds, and preview startup uses 90 seconds. Their results are kept in the
corresponding `.tmp/` directories. The
[shared preview decision](../../.agents/notes/implemented/testing/2026-11-05-shared-team-navigation-preview.md)
owns preparation sharing, isolation and deadline handling.

The required coverage comparison is `covered * 10 > total * 9` using BigInt.
Exactly 90% fails independently of display rounding. Pure-type declarations
contribute zero statements only after the pinned TypeScript compiler confirms
there is no runtime body. Temporary compiler inputs and outputs stay under this
package's `.tmp/` and are removed after classification. Typechecking remains a
separate mandatory check.

PR CI selects affected modules using the [repository routing rules](../../README.md#ci-selection).
The Web selector starts `verify-web-quality` after module detection. This job
has a 30-minute limit, and final `checks` requires it to succeed when selected.
It runs full typechecking, the harness, the Docker Web build, Vitest/V8 collection
and coverage checking serially with bounded stages and uploads coverage evidence.
The separate [`shell and browser acceptance` workflow](../../.github/workflows/shell-browser.yml)
runs the assistant and ordinary Session draft suites below on `main` pushes and manual dispatch. Its browser
job has a 20-minute limit and prepares its own runner without a quality artifact
or result dependency. Ordinary Web unit and quality commands do not launch
browser fixtures. The explicit module browser entry separately runs the
navigation, Team, assistant and other fixture configurations.

The independent login completion page validates the local return target and callback
path supplied by the successful server callback. It retains the target query and
fragment and uses the callback path to preserve the original destination of accepted
relative references. It waits for server-confirmed identity and local account
publication before replacing the document. Identity and publication retries are
separate; a superseded account requires an explicit reload.
The identity-cache browser fixture exercises the completion entry and native
cross-page storage and BroadcastChannel signals with controlled API responses.

The controlled `AccountChangeBanner` presents a localized polite status and a
caller-supplied refresh action in the active header. Inactive instances keep an empty live region without presenting or announcing a notice.
The region exists before its message is populated. The caller chooses the active header and supplies the real reload action;
the component does not discover identity or connect existing business headers.
The session-header browser configuration also builds a controlled production
component fixture for normal, native modal and fullscreen headers. Run it with
`pnpm --filter @codetreker/daynight-web exec playwright test --config tests/navigation/session-header-playwright.config.ts`.

## Independent browser checks

Run all module browser configurations after installing Chromium with
`pnpm web:test:browser`, or run the Project withdrawal fixture directly:

```bash
pnpm --filter @codetreker/daynight-web exec playwright test --config tests/navigation/project-withdrawal-playwright.config.ts
```

The Project withdrawal fixture uses controlled API responses across multiple
tabs with Chromium's IndexedDB and BroadcastChannel. It exercises withdrawal,
late reads and fresh access, but does not call a real service. Their configured
fixtures and cleanup belong to each suite. These checks cover
browser interaction under controlled responses; they do not prove live service,
PostgreSQL, installed-CLI or native/container integration. The Go startup/shutdown test
[`TestAttachmentGrantRevocationWithFreshProcess`](../daynight-server/cmd/daynight-server/attachment_grant_revocation_test.go)
separately verifies that member removal and new Project-access refusal complete
while an admitted 1 MiB upload is incomplete, followed by its successful
completion, attachment refusal, byte verification and cleanup. The
[acceptance ownership decision](../../.agents/notes/implemented/testing/2026-11-06-attachment-admission-acceptance-ownership.md)
records the division.


### Assistant browser validation

The [Bot viewport suite](tests/navigation/bots-viewport.browser.ts),
[persistent history suite](tests/navigation/bot-persistent-history.browser.ts),
[cache composition suite](tests/navigation/bot-cache-combination.browser.ts) and
[assistant presentation suite](tests/navigation/assistant-modern.browser.ts) run
the production application, Session host and timeline against controlled HTTP and
Session API responses. Together they cover responsive navigation, assistant creation,
search, unified controls, details, Focus mode, retained DOM/drafts/reading anchors,
long history and pagination, empty suggestions, errors, archives and identity
pause. Cases include English and Simplified Chinese, desktop and phone widths,
390×300 short viewports, reduced motion, accessible names and normal text contrast.
The details tests check both 1279/1280px window and 759/760px stable-container
boundaries, including opening details without layout oscillation.
Persistent history checks use the production observer and real browser
localStorage across reload, closed-page reopening, pane eviction and cross-tab
invalidation. Controlled detail/current/history barriers verify the same timeline
and article DOM, reading anchors, and zero resource access during previews at
1440px, 390px and 320px. Multi-tab idle checks detect LRU write feedback; cold
access-loss checks keep the narrow-screen return path available.
Cache composition checks join real pagination with Latest cancellation, history
updates and identity replacement; visit seven targets under the independent
pane and disk budgets; and hold native Web Locks across cross-tab revocation
and queued reads or writes. The component suite separately checks every write
entrance and original-operation recovery while the actual page awaits detail
confirmation. The [composition decision](../../.agents/notes/implemented/testing/2026-11-10-bot-cache-composition.md)
owns the proof boundaries and the choice to retain lower-level fault matrices
with their existing owners.

From the repository root, with the workspace dependencies installed:

```bash
pnpm --filter @codetreker/daynight-web exec playwright install chromium
pnpm --filter @codetreker/daynight-web exec playwright test --config tests/navigation/bots-viewport-playwright.config.ts --list
pnpm --filter @codetreker/daynight-web exec playwright test --config tests/navigation/bots-viewport-playwright.config.ts
```

The [configuration](tests/navigation/bots-viewport-playwright.config.ts) discovers
the assistant fixture files and starts its own Vite host on `127.0.0.1:4198`; keep that port free.
It uses one worker, zero retries and a 45-second test timeout. An installed Chrome
can be selected with `DAYNIGHT_BROWSER_CHANNEL=chrome` on the test command; record
that browser choice with the result. Captures are saved under
`packages/daynight-web/.tmp/acceptance/bots-viewport/`.
The [`shell and browser acceptance` workflow](../../.github/workflows/shell-browser.yml)
runs the same suite in `verify-web-browser` on every `main` push and through
`workflow_dispatch`. Its fresh runner installs the locked dependencies and
Chromium, then the Playwright configuration starts its
own Vite host. It uploads `daynight-web-assistant-browser` with JUnit results and
browser captures, including available evidence after a failed browser run.
The same job then runs the ordinary Session draft configuration and uploads
`daynight-web-session-drafts-browser` with its JSON report and failure captures.
The separate capacity configuration remains local-only. The
[draft acceptance decision](../../.agents/notes/implemented/testing/2026-11-13-session-draft-browser-acceptance.md)
owns this suite's evidence and scheduling boundaries.
The ordinary PR `checks` workflow neither invokes nor waits for this job. A
successful PR gate does not establish a hosted assistant-browser result; a
main-push or manually dispatched result belongs to that run's checked-out
revision. The [workflow decision](../../.agents/notes/implemented/testing/2026-11-12-shell-browser-workflow.md)
records this scheduling trade-off. Product E2E retains its own browser and
selected-job gate.

These tests prove browser consumption and presentation with controlled services;
the creation responses, Session operations and archived history are fixtures.
They do not prove live backend creation/deletion, Worker cleanup, native Provider
execution, production deployment or a physical phone's keyboard behavior. Static
prototypes and screenshots also cannot establish those results. Real lifecycle
acceptance requires an isolated authorized account/Bot and the actual HTTP,
Worker and Provider path; record each layer's observations and unverified items
separately, following the [management](../../docs/design/bot-management-web.md)
and [Session](../../docs/design/bot-session-view.md) validation responsibilities.

## Production browser acceptance

The Web quality command does not run a cross-product acceptance suite. Controlled
browser fixtures establish only their stated frontend scope. A real-service result
requires its own source-bound execution and cleanup evidence.

`pnpm web:acceptance` runs the project task search browser checks against a
production Web build embedded in a locally built Go server, a disposable
PostgreSQL 18.6 Docker container and the pinned UniAuth fixture. It requires
Node.js 24, pnpm 11.28.6, Go 1.27.2, Docker with Linux host networking and a
Playwright Chromium installation. By default Chromium is read from the
worktree's `.tmp/playwright-browsers`; set `PLAYWRIGHT_BROWSERS_PATH` to use an
existing installation. The result under `.tmp/task-search-acceptance/` records
the source fingerprint, server binary and browser asset hashes and observed
checks. The runner removes its own server, fixture and database resources.
This focused result does not replace complete cross-product acceptance. The
independent [Product E2E framework](../e2e_tests/README.md) builds the complete
CLI/Web/Server and full UniAuth, starts its own isolated PostgreSQL and tests
normal cross-client workflows through `pnpm e2e:test`. It is separate from Web
module quality and browser fixture commands.

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
model separately verifies visible-edge acyclicity, status/readiness and summary
consistency. References to unavailable prerequisites remain in the Task, but
only visible endpoints form adjacency; the server supplies their satisfaction. It derives ordinary-edge weak components and their current
representatives. `mainIds` contains the complete ordinary component;
`externalIds` contains only its direct external prerequisites outside that
component, deduplicated by task ID. Projection P is their union and retains every
real edge whose endpoints are in P; context does not recurse. Visibility selects
S and all real edges with both endpoints in S. Edge classification comes from the
persisted `externalDependsOn` marker, including external shortcuts within an
ordinary component. Progress and aggregate chain status count main members only,
and each task has one ordinary-component membership. Complete ancestry remains
available to inspection through the full project index. The Dagre
adapter returns finite left-to-right or top-to-bottom node positions and routed edge points for
220px-wide visible cards with 96px compact or 136px action-footer heights.
External cards retain the 136px footer for their independent Expand action. The
read-only React Flow canvas consumes these results without changing domain
objects. React Flow owns task nodes with those exact dimensions, native ResizeObserver measurement,
keyboard behavior, viewport and controls. One memoized SVG in its public
ViewportPortal renders every planned M/L/C path, with stable edge identity,
arrowheads, explicit external-edge dashes and accessibility semantics. It shares the viewport's
transform, so selection/pan/zoom reuse geometry without per-edge reactive state.
Canonical routes retain native arrow markers and the full planned geometry.
Passages use cubic Bézier curves entirely within empty rank gaps, with controls on the gap midpoint at the respective endpoint cross-axis coordinates. Tangents follow the selected direction and join free passages through intermediate ranks, which retain sixteen units of clearance from cards. The
[Bézier routing decision](../../.agents/notes/archived/architecture/2026-10-25-bezier-task-dependency-routing.md) records the rationale for the shape and avoidance mechanism. Dashed body paint uses `routes.ts` to
derive locally rotated lines and exact cubic subcurves, with the
original 5/4 pattern and continuous positive arc-length phase. Every paint piece
has at most 8,192 graph units of arc length; internal cuts fall at global dash-gap
midpoints to bound GPU work without removing route geometry. Cumulative phase
error stays within 0.025 CSS px at maximum 1.8 zoom. Solid bodies remain native.
Pieces are noninteractive and hidden from the accessibility tree; canonical edges
keep their existing identity/semantics. The
[paint decision](../../.agents/notes/archived/bug-fix/2026-10-20-long-dashed-dependency-paint.md)
owns the pinned raster evidence and local-line rationale; the
[bounded-line extension](../../.agents/notes/archived/bug-fix/2026-10-22-bounded-dashed-dependency-lines.md) records the rationale for the original GPU stroke bound and its added DOM cost.
Ordinary chain initial placement uses current visible layout bounds after the viewport and positive
measured canvas dimensions are ready, fitting within 0.8–1 zoom or anchoring the
leftmost rank at 0.8 zoom. The root remains vertically centered when already
leftmost; otherwise the topmost upstream node starts at a 32px canvas inset.
Goal graphs use a separate compact component and rank-grid layout, with a
readable initial viewport and an explicit full overview.
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
refreshes coalesce an in-flight follow-up. The authenticated task cache owns shared project summaries. Push subscriptions
remain deferred; they can trigger the same synchronization without changing graph
projection. Production
`AuthenticatedApp` owns identity loading, authentication and account/membership
flows under the persistent locale Provider. New identities discard user-owned
requests and content; project 404 and discovery failures retain their distinct
resource and provider meanings.
