# Agent Note: Task inspection design and delivery boundaries

Status: implemented

## Problem

Opening task details on every graph-card click prevents persistent dependency
inspection. Direct external prerequisites provide useful context but omit the
ancestry needed to trace a task's complete prerequisite path. Routed polylines
have abrupt bends, and a narrow text-only detail drawer constrains reading
structured descriptions and planning attachments.

## Decision

The adopted [requirements](../../../../docs/spec/daynight-task-inspection.md)
and [design](../../../../docs/design/daynight-task-inspection.md) define the
target behavior. This delivery consists of that design, an interactive visual
prototype and a four-task implementation breakdown. The
[complete prerequisite context decision](../feature/2026-10-22-complete-prerequisite-context.md)
implements the first task: complete ancestors, separate counts and a readable
upstream-aware initial viewport. The
[centered detail decision](../feature/2026-10-22-centered-task-detail-dialog.md)
implements the reading shell while retaining existing modal and attachment
ownership. The [attachment split-view decision](2026-10-22-task-attachment-split-view.md)
extends that shell with Overview/Attachments tabs, retained attachment state and
a bounded two-pane preview. Inspection and smooth routes use the mechanisms
recorded below. The [Markdown description decision](2026-10-22-task-description-markdown.md)
extends the reader with shared CommonMark/GFM and root-based attachment
navigation. Existing paint and detail notes describe their current mechanisms.

The [progressive overview decision](../feature/2026-10-22-progressive-task-graph.md)
partially supersedes all-context-at-once rendering. PR134 delivered bounded visible graphs and explicit expansion/reset, retaining
body-open-details and polylines. The first inspection PR #121 was abandoned; a
clean current-main replacement owns independent selection/Details and smooth
highlighting. The abandoned PR's runtime results remain historical.

The root and its descendants remain the chain's counted membership. Rendering
adds the complete prerequisite closure without importing unrelated descendants
of contextual tasks. Selection belongs to the mounted graph and highlights the
selected task's visible ancestors and all their real visible routes/arrows,
with a deduplicated hidden-ancestor count from complete data. Detail resource
selection remains independent, with sibling card controls and one centered
dialog shared by all detail entry points.

The original smooth-route target retained raw Dagre points to preserve lane
intent and long paint spans. The
[uniform-routing decision](2026-10-22-uniform-task-dependency-routing.md)
replaced that target with fixed-side-port column planning and bounded quadratic
corners. The [Bézier routing decision](2026-10-25-bezier-task-dependency-routing.md)
retains its free-row planning and separates node placement from edge validity,
while complete cubic curves span empty column gaps. Long straight spans retain
local-axis dash painting; cubic paint uses bounded exact subcurves. One compiled
route owns body geometry and marker direction;
independent acceptance must understand curves and continue checking complete
coverage, dash continuity and real production timing.

Descriptions use the shared CommonMark/GFM view. Explicit root/document bases
keep description resources relative to the task attachment root and attachment
resources relative to their real document directory. Ordinary relative file
links select and focus the existing preview through one attachment-state owner
and activate its tab; complete-inventory checks and visible errors share that
owner. The published skill teaches self-contained Markdown briefs with concrete
actions, scope, deliverables, constraints, brief observable completion and actual
references. The [task-content and handoff decision](../process/2026-10-25-task-content-handoff.md)
now permits full content in the description or required referenced documents and
requires a designated task-local confirmation and evidence location. It replaces
the original primary-attachment storage rule without changing this reading
composition, Goal stages or independent execution and delivery authority.

## Alternatives

**Highlight only direct prerequisites or only currently visible ancestors.**
This preserves the current projection but cannot show the complete upstream
path. The selected behavior includes transitive ancestry and completed tasks.

**Add missing ancestors after a card is selected.** This reduces initial context
but changes layout during inspection. Expanding the closure when the chain
opens keeps later selection purely presentational.

**Use endpoint-only cubic Bézier or smoothstep paths.** Both are established
curve mechanisms, but their endpoint-based helpers discard Dagre's routed
waypoints. They would require renewed routing and long dashed-paint behavior.
Local rounding preserves the layout's route intent and long straight spans.

**Keep one card button and add a detail link inside it.** Nested interactive
controls have conflicting activation and keyboard behavior. Sibling native
controls keep inspection and dialog activation explicit.

**Give description navigation its own attachment controller.** Independent
controllers duplicate list reads and disagree about selection and failures.
The detail composition shares one existing attachment state owner instead.

**Deliver the feature as one task or defer integration checks.** A single task
couples independent reading and graph changes; a test-only successor permits
earlier tasks to ship incomplete behavior. Four focused outcomes keep each
delivery reviewable and responsible for its own observable acceptance.

## Consequences

Complete ancestry can make one expanded chain approach the complete-project
limit, so the existing capacity matrix and performance budgets remain required.
Many nodes and edges may change style during selection; the former two-node
selection cost assumption no longer establishes feedback time. Curved dash
length and independent geometry validation are substantive work.

Task-field editing, a Markdown editor, generated heading anchors, a new layout
engine and new telemetry are outside this design. These are additive features
or separate structural decisions. Keeping raw description strings, independent
selection/resource state, caller-owned URL handling and immutable route
geometry preserves affordable extension points without claiming those features.

The [projection](../feature/2026-10-20-task-graph-projection.md) note retains the
original direct-boundary rationale and links its replacement. The existing
[paint repair](../bug-fix/2026-10-20-long-dashed-dependency-paint.md) and
[fullscreen](../feature/2026-10-22-task-graph-fullscreen.md) notes remain current
for the retained rendering and modal ownership; the centered detail decision
extends the fullscreen and detail composition without changing those lifecycles. The standalone prototype proves its own
interaction, not production behavior or capacity.
