# Agent Note: Read-only Project Task Dashboard

Status: implemented

## Problem

The complete graph API and pure projection model need a browser workflow that
preserves snapshot meaning during navigation, refresh and detail reads. A live
task detail can differ from a previously loaded graph even when the task's own
timestamp is unchanged, because prerequisite completion changes readiness.
Keyboard users also need one reliable node action and a modal lifecycle that
does not leave background content interactive. At the declared 5,000-edge limit,
viewport controls must remain responsive while every dependency remains present
and aligned with its task nodes.

## Decision

The project page owns one validated graph/index snapshot, its client receipt time
and revision. Requests are scoped by project identity and generation; a different
resource cannot render an earlier resource's data. Same-project refresh retains
the last successful snapshot. Manual refresh displays busy text in its disabled
button, and recoverable failure displays an error beside prior data. The
[refresh presentation decision](../../implemented/simplification/2026-10-22-project-refresh-notice.md)
partially supersedes the original separate loading notice while retaining its
freshness feedback through the button and failure state. Changed data replaces
statistics, indexes and both task-category lists together. The [automatic refresh decision](../../implemented/feature/2026-10-22-project-task-auto-refresh.md)
extends request scheduling with visible-page periodic reads, retains equivalent
graph/index references and preserves the same-task detail body during refresh.

The [task view decision](../../implemented/feature/2026-10-22-project-task-views.md) separates standalone
rows, which open details directly, from non-isolated root chains. Only one root
canvas is mounted in the active chain category; inactive inner-category
contents unmount while their hidden wrappers retain stable tabpanel IDs. The
[project section decision](../../implemented/feature/2026-10-25-project-overview-task-sections.md) keeps
the visited Task list subtree mounted across outer Overview switches and
isolates its page scroll ownership. The project opens one graph dialog after an
explicit dependency-graph action; the [graph-dialog
decision](../../implemented/feature/2026-10-26-task-chain-graph-dialog.md) replaces inline graph
expansion and persisted opening while retaining one mounted graph. The
[Goal-list decision](../../implemented/feature/2026-10-26-goal-task-lists.md) gives the row body a
separate compact member list without changing graph resources. Independent
section, category, filter and page-position records remain with the [browsing
preference decision](2026-10-21-task-browsing-preferences.md). The
[presentation decision](2026-10-21-task-chain-presentation.md) owns
newest-first visible chain order while the complete graph index retains its API
order. React Flow owns 220px-wide task cards, 96px high without expansion
controls and 136px with them, following the [conditional footer
decision](../../implemented/bug-fix/2026-10-22-task-card-expansion-footer.md), native node
measurement, keyboard interaction, the viewport and its controls. Editing,
connection, deletion, wrapper focus and interactive-lock controls remain
disabled. Each task has one native button for pointer, Enter and Space
activation; keyboard focus pans offscreen nodes without changing zoom.

One memoized SVG beneath task nodes in the public `ViewportPortal` renders every
dependency from immutable planned geometry. The
[Bézier routing decision](../../implemented/architecture/2026-10-25-bezier-task-dependency-routing.md)
retains Dagre node placement while owning fixed lateral ports, free-row passages
and cubic transitions across empty column gaps. Canonical paths retain complete
geometry, stable edge/source/target identity, native arrow markers and
accessibility semantics. Solid bodies keep native paint. Dashed bodies use
immutable locally horizontal lines and bounded exact cubic subcurves, preserving
full arc length and dash phase through the
[long-dashed paint decision](../bug-fix/2026-10-20-long-dashed-dependency-paint.md).
The portal shares the React Flow viewport transform; pan and zoom transform the
same complete paths without per-edge store subscriptions or endpoint-admission
work. Selection keeps the edge layer stable. Edges do not intercept pointer
input, so task buttons and the canvas remain the interaction targets.

The original custom-edge integration used invisible framework ports for
edge admission. That choice preserved Dagre's noncentral rectangle intersections:
framework port centers never defined the visible line endpoints. The static SVG
established a separate rendering owner for immutable routes; the current Bézier
planner owns the endpoint and card-avoidance rules. The initial single-SVG
implementation used native dashing
on each full route, preserving direct geometry without per-edge reactive state.
The long-dashed paint decision partially replaces that body-paint choice after
pinned-engine raster evidence, while canonical routes and native arrows remain.
It uses no connection-port DOM or node-handle readiness state. Initial placement uses known layout bounds after the framework viewport
and positive measured canvas dimensions are ready; native ResizeObserver node
measurement remains enabled.

Initial viewport policy keeps readable zoom. When the graph cannot fit at that
zoom, the chosen root is placed near the left edge and vertically centered;
centering the entire bounding box would open a long chain in its middle. The
policy runs once after initialization, while explicit overview controls may
zoom out further. Selection and viewport movement do not rerun layout.

A layout/callback pair owns immutable ordinary and selected variants for each
node. Selection reuses all unaffected references and swaps only the previous and
next selected variants; closing swaps only the previous selection. React Flow
can therefore update selection styling without rendering every task again. The [progressive overview decision](../../implemented/feature/2026-10-22-progressive-task-graph.md) changes
all-input rendering into explicit visible S. Every visible node and induced edge
retains complete DOM and geometry, which preserves focus, graph inspection
and complete-capacity assertions. Component tests check the changed-node rendering
counts for open, switch and close transitions. This structure keeps detail-opening
work proportional to changed styling while retaining the full graph.

Each chain row is memoized. Graph inspection and task-detail selection live
outside the static row rendering, so those changes do not rerender unrelated
rows. Callback and index changes still invalidate the relevant rows; a changed
snapshot index refreshes every row and its statistics. Equivalent responses
retain the existing index while advancing the successful receipt revision.

The centered task detail dialog uses a body portal outside the application root,
background inertness,
body scroll ownership and a dynamic focus trap. Its lifetime is independent of
relation selection. Layout cleanup synchronously releases the keyboard listener,
background inertness and scroll ownership. A separate passive unmount cleanup
calls the latest restoration callback after sibling DOM deletion. It focuses a surviving original trigger, otherwise a visible control in the
active task view. The task view decision extends that fallback to standalone
rows and tabs; a truly empty project retains the project H1 fallback. This ordering avoids selecting a still-connected node that the
same commit will remove; the [focus-restoration decision](../bug-fix/2026-10-20-drawer-focus-restoration.md)
records the failure and integration evidence. The
[Web attachment decision](2026-10-21-task-attachment-web.md) extends this lifecycle
with `tabbable` enumeration for form controls and same-origin frame keyboard
bridges; background ownership and passive restoration remain unchanged.
The [centered detail decision](../../implemented/feature/2026-10-22-centered-task-detail-dialog.md)
partially supersedes the original right-side layout with a centered reading shell
and responsive content columns, while retaining this modal lifecycle.
Latest detail data never patches graph statistics.
Readiness, blocking, dependency, status, preview and timestamp differences produce
a refresh notice. The [detail-cache decision](../../implemented/architecture/2026-10-24-task-view-timestamp-window.md)
owns business-version-driven reads, matching intrinsic reuse and live admission;
a clock-only graph receipt does not reread unchanged details.

The pinned React Flow dependency needs a declaration-only mapped-type correction
under exact optional property checking. Two system declarations explicitly
intersect their known NodeBase constraint before the generic omission. Runtime
bundles are unchanged; product strictness and library typechecks remain enabled.
Compile-time assertions preserve custom fields and reject explicit undefined
source/target positions. The
[pinned source](https://github.com/xyflow/xyflow/blob/3d35b57317576b0916c0bfeaaedd573aaacc2839/packages/system/src/types/nodes.ts)
and [runtime conversion](https://github.com/xyflow/xyflow/blob/3d35b57317576b0916c0bfeaaedd573aaacc2839/packages/system/src/utils/store.ts#L146-L170)
define that relationship. The locked pnpm patch is a build input for local, CI
and container builds.

The [requirements](../../../../docs/spec/daynight-web.md) own behavior and the
[architecture](../../../../docs/design/daynight-web.md) owns module contracts.
[Embedded delivery and isolated deployment](../architecture/2026-10-20-embedded-dashboard-deployment.md)
are implemented. The [production acceptance harness](../testing/2026-10-20-dashboard-production-acceptance.md)
verifies both targets and fixed capacity without changing page runtime policy.

## Alternatives

**Update graph nodes from detail responses.** That mixes independent reads and
can leave global counts or related nodes inconsistent. Explicit stale detection
and complete snapshot replacement retain the single-snapshot meaning.

**Keep the default interactive canvas controls.** The lock control can re-enable
editing, and wrapper keyboard selection does not open task details. A single
native button plus explicit read-only props implements the intended actions.

**Represent every immutable dependency as a reactive React Flow edge.** Each
edge then owns wrapper/SVG/store and endpoint bookkeeping. At 5,000 edges those
units participate in viewport work even though the route geometry does not
change. The single public-portal SVG retains every route while the framework
continues to own nodes, viewport interaction and controls.

**Recreate every node data object on selection.** The selection becomes visible,
but all task props change and a detail action can rerender the complete
1,000-node graph. Canonical ordinary/selected variants preserve the immutable
layout and limit updates to the styling that actually changed.

**Always center the complete graph at a clamped readable zoom.** In a thousand-node
chain, its root falls far outside the viewport. Root anchoring preserves the
starting point while retaining pan and overview controls.

**Disable library type checking or widen all optional positions.** That hides the
generic constraint defect or weakens the declared input contract. The scoped
declaration patch and negative type assertions keep those checks meaningful.

## Consequences

Project browsing now reaches real statistics, dependency diagrams and task
details. Controlled component tests cover state/focus transitions, while a local
production-bundle browser check also uses the real Go API and PostgreSQL. PR #52's earlier hosted shared-graph zoom failure
is retained. A later hosted run also exceeded the shared-graph zoom budget;
diagnostics identify prior drawer-close raster/commit backpressure from long
native dashed routes. A controlled local-coordinate decomposition prototype
reduces that raster work. The committed helper passes complete local production,
capacity and independent geometry/phase checks; actual product traces confirm
the reduced raster. Production acceptance is delivered through
[PR #52](https://github.com/codetreker/daynight/pull/52). Actual browser
checks verify SVG/node alignment and exact route endpoints after zoom, pan and
root changes. Dependency upgrades must revisit the declaration patch and type tests.

The historical [project screenshot](../../../../docs/research/assets/daynight-web-project.png)
and [detail screenshot](../../../../docs/research/assets/daynight-web-detail.png)
use generated fixture data from the earlier production-browser functional check.
They illustrate that workflow, before the current renderer and capacity
acceptance, and do not establish current-source performance or hosted delivery.
