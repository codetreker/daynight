# Agent Note: Read-only project dashboard design

Status: implemented

## Problem

Projects and dependency-gated tasks are available through JSON APIs, but there is
no browser view for project progress or execution dependencies. Tasks form a DAG,
not a parent-child hierarchy. Multiple source tasks can share descendants, so a
tree presentation or summed per-root counters would misrepresent the data.

## Decision

The adopted MVP design defines project browsing, project-level statistics,
expandable source-root graphs, and a task detail drawer. The
[requirements](../../../../docs/spec/daynight-web.md) own visible behavior, the
[design](../../../../docs/design/daynight-web.md) owns implementation contracts,
and the [interactive preview](../../../../docs/design/mockups/task-dashboard.html)
demonstrates the original appearance. The later [task view decision](../../implemented/feature/2026-10-22-project-task-views.md)
separates standalone task rows from chain graphs within project tabs, using
the [task view mockup](../../../../docs/design/mockups/task-views.html). This note
records the delivered MVP design; the
[centered detail decision](../../implemented/feature/2026-10-22-centered-task-detail-dialog.md)
partially supersedes its right-side reading layout while retaining snapshot and
modal ownership. The complete graph read and [project browsing foundation](2026-10-20-web-project-browsing.md)
and the [pure graph model and layout](../feature/2026-10-20-task-graph-projection.md)
are implemented. The [project task dashboard](../feature/2026-10-20-project-task-dashboard.md)
implements visualization and detail navigation. The
[embedded deployment](2026-10-20-embedded-dashboard-deployment.md) implements
Go asset delivery and the localhost/dev-ci environments. Full production-browser
and fixed-dataset performance evidence is tracked by the
[production acceptance harness](../testing/2026-10-20-dashboard-production-acceptance.md).
The earlier renderer passed local targets but failed the hosted zoom budget. The
static SVG edge layer needed a further
[long-dashed paint fix](../bug-fix/2026-10-20-long-dashed-dependency-paint.md), which
passes complete local targets and the fixed capacity matrix. Actual local deployment-fault evidence remains separate and predates the
SVG update. Production acceptance is delivered through
[PR #52](https://github.com/codetreker/daynight/pull/52);
its corresponding PR and CI own source-specific verification.

Use a separate React/TypeScript/Vite package with React Flow and Dagre. Serve
its built assets from the existing loopback Go origin, embedded into the binary.
Keep the client review module and its configuration/storage independent. A web build is
an explicit prerequisite for clean server builds, with a visible error when
assets are absent. The Docker-only localhost path uses a pinned Node
frontend build stage and repository-root build context; the final image remains
a nonroot Go runtime. Preserve stream forwarding, loopback publication, health
checks and database persistence. The existing localhost entry point starts the
complete UI/API/database stack and retains normal user data. The separate
`deployment/dev-ci/` uses that same Dockerfile and nginx configuration with a
unique Compose project, dynamically allocated loopback HTTP port, and disposable
project-scoped database, volumes and network. Browser acceptance uses that
isolated stack; Go coverage and direct-process tests keep their existing isolated
database mechanism.

The implemented [complete graph read](../feature/2026-10-20-complete-task-graph-read.md)
returns complete graph metadata and statistics
from the existing read-only REPEATABLE READ mechanism. Existing paged task
reads do not share a cross-page snapshot. Graph nodes omit descriptions and
contain bounded title previews; full content uses the existing detail endpoint.
Reject graphs exceeding the declared size limits without returning a partial
success. The original graph read required no schema, parent-child or write-policy
changes. The later [four-state reader decision](../../implemented/feature/2026-10-22-proposed-task-readers.md)
extends stored status and reader projections without activating new writes.

The original MVP expanded each root and its forward-reachable descendants,
adding explicit direct-boundary prerequisite nodes without expanding their
ancestors. The later
[complete context decision](../../implemented/feature/2026-10-22-complete-prerequisite-context.md)
replaces that boundary with every required ancestor and dependency, excluding
unrelated descendants of contextual tasks. The later
[external dependency decision](../../implemented/architecture/2026-10-23-external-dependency-design.md) replaces
per-root membership with ordinary-edge weak components while keeping that full
ancestor context. Progress counts component members only; project totals count
each task once. Only one chain graph is mounted at a time. Pure indexing/projection and Dagre layout remain separate from React rendering and API requests. Page hooks own
request cancellation and snapshot replacement; the task detail dialog never mutates the
project snapshot.

The adopted MVP was read-only with manual refresh. Graph projection remained
separate from API mutations and request triggers so editing and live subscriptions
could be added independently. The later
[automatic refresh decision](../../implemented/feature/2026-10-22-project-task-auto-refresh.md)
partially supersedes the manual trigger policy with visible-page periodic reads,
retaining complete-snapshot ownership and resource isolation. The later
[Web attachment decision](../feature/2026-10-21-task-attachment-web.md) uses that
separation for file upload, overwrite and deletion in task details. Task fields and
dependency editing remain outside the browser's delivered scope. The
[status assignment decision](../../implemented/architecture/2026-10-24-task-status-assignment.md) provides a
three-item status menu in full details with reviewed versions, shared permission
mutation ownership and coordinated snapshot refresh. Task creation and three-state
projection agree across service, CLI and browser. Remote access
is not an additive configuration change: authentication, authorization, and deployment boundaries require their
own design. Graph filtering must retain dependency context; large-graph support
needs a new closed-subgraph contract or measured limit changes.

Require strict unrounded statement coverage above 90% independently for Go and
web, preserving existing Go and native CLI gates. Real-browser acceptance must
exercise the production UI, Go process, and PostgreSQL together.

The dev-ci runner registers bounded cleanup before creating resources, records
the built and running image identity, and exports the discovered URL to the test
command. Cleanup rejects non-test project identities and removes only the current
run. Failed cleanup fails acceptance without discarding the original test error.
The runner retains ownership of the callback process group after the leader
exits, so background descendants are stopped before environment cleanup. Recovery
accepts only an existing run receipt and preserves its original manifest. Test
runs never start, rebuild, or remove the daily localhost stack.

## Alternatives

**Replace React Flow with a complete custom SVG canvas and Dagre.** This permits
the visual design, but product code would own pan/zoom, coordinate transforms,
keyboard navigation, focus and their tests. React Flow supplies those interaction
primitives. The adopted static edge SVG uses its public ViewportPortal, while
React Flow continues to own task nodes, viewport and controls. The
standalone preview draws SVG with local JavaScript and does not select a product
framework or layout dependency.

**Vue with Vue Flow and Dagre.** This is technically suitable. The repository has
no established Vue application, so it does not reduce integration work compared
with the selected React stack.

**Concatenate existing task pages.** This avoids a new endpoint but cannot
provide one consistent graph and statistical snapshot while tasks change.
Filtered pages can also omit required predecessor nodes.

**Separate production frontend server.** This avoids embedding assets but adds
another runtime deployment and cross-origin configuration to a local dashboard.
One-origin Go delivery keeps installation aligned with the existing service.

**Use the daily localhost stack for tests or as an override base.** Its fixed
project identity, default port and persistent volume can collide with normal
work. Independent test Compose configuration reuses the production build and
forwarding files while making ownership explicit. Topology checks constrain
configuration drift between the two environment definitions.

## Consequences

The design completes a narrow viewing workflow without adding editing or
realtime infrastructure. Frontend and backend gain independent coverage gates,
and clean Go builds gain a documented frontend build prerequisite. Container
builds need the same frontend sources and command but require no host Node
installation. The design uses the existing ServeMux and one request-logging
wrapper for both UI and API requests. Dev-ci has a second Compose definition
and lifecycle tests; shared build/proxy artifacts and explicit topology checks
keep that additional configuration aligned. Daily data persists, while each test
run owns and removes its disposable dataset.

Shared task rows are intentionally non-additive. Boundary markers and explicit
snapshot freshness are necessary for an honest graph. The protective graph
limits are product constraints, not measured capacity claims. The single local 1,000-node chain probe does not establish the boundary-size
performance requirements. The earlier renderer passed the local matrix, but a
hosted zoom failure required a new full matrix for the static SVG renderer. That
new local matrix passes; production acceptance is delivered through PR #52.
Fixed-topology results do not promise arbitrary-DAG latency.

The existing [server task design](2026-10-19-daynight-server-task-design.md)
remains the owner of the service domain and transaction rules; this decision
adds a browser consumer without replacing those rules.
