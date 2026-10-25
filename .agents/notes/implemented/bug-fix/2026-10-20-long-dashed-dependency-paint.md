# Agent Note: Draw Long Dashed Dependencies in Local Coordinates

Status: implemented

## Problem

A complete task graph can contain thousands of long oblique dependency routes.
Native SVG dashing can generate their full offscreen arc length during raster,
even when the visible diagram occupies a small viewport. Earlier drawer-close
paint can then delay a subsequent zoom commit beyond the 300ms feedback budget,
although the zoom handler itself is prompt. Every task, dependency, arrow,
boundary dash and modal interaction must remain present.

## Decision

The single SVG in React Flow's public ViewportPortal keeps every canonical
planned route, stable identity and native arrow marker. Solid routes retain
native body paint. Dashed bodies use immutable paint pieces derived from the
complete route: locally horizontal lines with world-space rotation and
translation, plus native paths for curved regions. The canonical dashed route
retains full geometry and marker ownership while separate body pieces own
stroke paint. This partially replaces the body-paint mechanism in the
[dashboard decision](../feature/2026-10-20-project-task-dashboard.md); graph
projection, ranking, viewport ownership and arrow geometry remain unchanged.

`compileDependencyRoute` uses the existing 5/4 dash pattern and nine-unit period.
Cuts fall at gap midpoints, seven units into that period. Each piece uses the
positive `startDistance % 9` offset, so a gap-midpoint start has two unpainted
units before its next dash. Native curved paths retain canonical geometry and
joins; cuts inside gaps do not introduce visible stroke caps. Long straight
pieces use unit-scale rotation/translation rather than changing world geometry,
stroke width or dash spacing. The
[SVG2 stroke-shape algorithm](https://www.w3.org/TR/SVG2/painting.html#StrokeShape)
owns that positive-offset interpretation.

The [bounded-line extension](2026-10-22-bounded-dashed-dependency-lines.md)
additionally limits each line to 8,192 graph units for macOS GPU rendering.
It preserves this local-coordinate mechanism and the historical CPU raster
evidence below while splitting long bodies at additional global dash gaps. The
[Bézier routing decision](../architecture/2026-10-25-bezier-task-dependency-routing.md)
replaces the earlier rounded bend shape with gap-confined cubic routes and
extends the same bound to exact cubic paint subcurves.

The pinned Chromium implementation explains why local coordinates matter.
[Chromium's DEPS](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/DEPS#L340)
pins Skia `95ee33d7ec7791ab9c071675710a14fe6408ae4f`.
[SkDashPath](https://github.com/google/skia/blob/95ee33d7ec7791ab9c071675710a14fe6408ae4f/src/utils/SkDashPath.cpp#L117)
rejects the diagonal native-line cull; its
[line/rectangle cases](https://github.com/google/skia/blob/95ee33d7ec7791ab9c071675710a14fe6408ae4f/src/utils/SkDashPath.cpp#L169)
can trim dash generation through the
[filter's cull attempt](https://github.com/google/skia/blob/95ee33d7ec7791ab9c071675710a14fe6408ae4f/src/utils/SkDashPath.cpp#L334), while the
[general generation loop](https://github.com/google/skia/blob/95ee33d7ec7791ab9c071675710a14fe6408ae4f/src/utils/SkDashPath.cpp#L399-L418)
walks arc length. SkDraw
[maps the device clip through the inverse CTM](https://github.com/google/skia/blob/95ee33d7ec7791ab9c071675710a14fe6408ae4f/src/core/SkDraw.cpp#L614)
and supplies that
[local clip before transforming the resulting path](https://github.com/google/skia/blob/95ee33d7ec7791ab9c071675710a14fe6408ae4f/src/core/SkDraw.cpp#L1033).
A locally horizontal line can therefore use native culling while its SVG
transform preserves the full oblique world-space route. Short bend paths keep
native join semantics without expensive long-path dash generation.

Native markers remain independent paint operations on the canonical route.
Blink's
[marker painting](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/third_party/blink/renderer/core/paint/svg_shape_painter.cc#L114)
and [marker stroke-width calculation](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/third_party/blink/renderer/core/layout/svg/layout_svg_shape.cc#L657)
retain arrow behavior when dashed body paint is separated. The route's stroke
width and native marker definition stay intact; arrow flattening is unnecessary.

The [acceptance decision](../testing/2026-10-20-dashboard-production-acceptance.md)
originally retained all 1,000 task nodes/buttons, exact canonical route counts
and complete paint
piece readiness, five repetitions and unchanged 3,000ms/300ms gates. The [progressive overview decision](../feature/2026-10-22-progressive-task-graph.md)
retains complete capacity input data and timing gates, replacing all-input DOM
readiness with bounded visible graphs and explicit expansion/reset. Every
visible polyline, native arrow and dashed piece remains checked. Modal root
inertness, focus restoration, native measurement and tracing stay enabled.
The committed [dashed-paint evidence](../../../../docs/research/evidence/daynight-web-dashed-paint.json)
retains captured graph/resource and investigation-script hashes, the pixel
comparison, whole-trace and scoped close-frame statistics, and actual product
trace/source identities. Its provenance distinguishes temporary browser-side
injection and CPU-sampled replay from the final helper and formal acceptance
traces. A successful diagnostic probe establishes execution of that probe;
complete real-service and clean hosted performance remain separate evidence.

## Alternatives

**Keep native dashing on each complete oblique route.** It directly matches the
Dagre polyline but permits full offscreen dash generation in the pinned raster
implementation. The inspected shared graph has 4,002 dashed routes and about
68.7 million units of arc length; repeating this work per tile creates prior-frame
backpressure despite a small visible viewport.

**Remove markers or flatten arrows.** Marker-removal trials retained the roughly
1.1-second prior drawer-close raster. Fast subsequent zoom occurred only when
input arrived after that work finished. It did not demonstrate a causal work
reduction, so native arrows remain the geometry owner.

**Change modal implementation, remove blur, or add paint containment.** Controlled
trials retained the long close-frame raster. They do not remove the demonstrated
dash-generation cost, and modal semantics remain required.

**Promote the SVG to its own layer.** The tested promotion increased raster work
to twelve tiles and roughly 7.7–8.1 summed raster-task seconds per frame. Layer separation alone
did not establish a reduction in the primitive's repeated work.

**Hide SVG paint or make dashed strokes solid.** These diagnostic ablations reduced
raster work and isolated the expensive paint, but they remove required dependency
appearance. They establish the investigation target, not a deliverable rendering
choice.

## Consequences

The graph keeps canonical routes and native arrows while adding explicit dashed
body pieces. The added DOM paint elements preserve the complete task and edge workload. Geometry/phase, endpoint/CTM alignment and pixel comparisons must verify
that decomposition preserves joins, dash continuity and visible output; readiness
must include the complete derived piece set.

A controlled axis-local prototype reduced the preceding close raster from about
1,100ms to 22–28ms with commit wait below 0.32ms, retaining all canonical graph,
arrow and modal semantics. The same prototype's 1328-by-445 pixel comparison changed 764 of 590,960 pixels
(0.1293%): 751 had maximum RGB delta one, thirteen exceeded one, three exceeded
four, and the maximum was seven on the 0–255 scale. Alpha was unchanged and mean
absolute RGB delta was 0.0006216. Differences were confined to a thin route
antialiasing region; this is not byte-identical output. These controlled results
are distinct from the final helper's verification. The implemented helper now
passes its complete local native/container workflow, all capacity repetitions,
independent arc/phase/CTM checks and cleanup. Actual product traces confirm the
reduced preceding raster work. Production acceptance is delivered through
[PR #52](https://github.com/codetreker/daynight/pull/52); its PR and CI retain
source-bound execution results. Pinned-engine evidence explains the mechanism; future
browser changes require renewed raster and visual validation without relaxing
product budgets.
