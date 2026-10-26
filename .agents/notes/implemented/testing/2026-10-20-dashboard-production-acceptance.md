# Agent Note: Production dashboard browser acceptance

Status: implemented

## Problem

Component tests and a preview server cannot establish that a clean Go build or
production image serves the dashboard correctly. Shared descendants, modal focus,
request replacement and capacity also depend on real browser behavior. A green
browser process can hide skipped or retried scenarios, incomplete measurements,
a mismatched image or cleanup failures unless its receipts are validated.

## Decision

The [status assignment decision](../architecture/2026-10-24-task-status-assignment.md) owns the current three-state
protocol. Status journeys use exact registered PUT status writes; current
inventory is 33 native and 28 container results. The rollout counts below retain
their original delivery context; repeatable current commands and mappings belong
to the Web README.

`pnpm web:acceptance` uses the shared acceptance runner to build real embedded
assets and a fresh native Go executable, own an isolated PostgreSQL 18.6
container/volume and wait for structured service readiness. The normal dev-ci
source build/start runs concurrently. Browser phases run twenty-four native functional
scenarios, the same twenty-four functional scenarios through the production image's
stream gateway, then five native capacity/limit scenarios. The normal localhost
stack and its data do not participate. The
[pipeline decision](2026-10-21-web-acceptance-pipeline.md) partially supersedes the
original native-then-container schedule and owns stage dependencies, per-phase
cleanup and evidence aggregation. The original ordering kept each complete
target serial and its resource lifetime easy to inspect; the replacement
preserves capacity isolation while overlapping preparation and retaining the
native process through the final capacity phase.

The original eight stable functional scenarios cover pagination, graph/statistics,
detail navigation, freshness, database failure/recovery, direct routes, keyboard
focus and narrow layout. The
[attachment acceptance decision](2026-10-21-task-attachment-cross-layer-acceptance.md)
adds `task-attachments`, sharing real data between the installed CLI and page on
both runtime targets and requiring visibly painted PDF content. The
[task view decision](../feature/2026-10-22-project-task-views.md) adds
`project-view-tabs` on both targets for topology classification, direct standalone
details and independent per-project browsing preferences. The native target also
runs four fixed capacity datasets and
independent node/edge-limit rejections. The
[complete context decision](../feature/2026-10-22-complete-prerequisite-context.md)
adds dense external ancestry while preserving the original three datasets. The
[bilingual interface decision](../feature/2026-10-22-web-bilingual-interface.md)
adds three targeted functional language scenarios to each target without
replicating the capacity matrix. The
[authentication activation](../architecture/2026-10-22-authentication-activation.md)
adds six functional scenarios per target, authoritative provider discovery and
normal UniAuth session/PAT bootstrap. The
[Markdown description delivery](../architecture/2026-10-22-task-description-markdown.md)
adds `task-description-markdown` to each functional target, producing the earlier
forty-five-result inventory. Its browser reads remain GET/HEAD-only after
authenticated fixture setup. The three original approval journeys brought the
aggregate to fifty-one. The historical
[withdrawal decision](../feature/2026-10-23-task-unapprove.md) added `task-unapproval`
to both functional targets, making that delivery aggregate fifty-three. Fixture data is created through real authenticated APIs;
the graph scenarios and task-view scenario retain read-only browser request
checks except for one exact registered fixture-file PUT in `refresh-staleness`.
The [quiet-detail decision](../bug-fix/2026-10-23-quiet-task-detail-refresh.md)
holds that upload response across automatic reads to verify pending-work
retention without admitting other mutations. The attachment and `language-state-preservation` scenarios
permit only their exact fixture-scoped file PUT/DELETE requests. The
[approval lifecycle](../feature/2026-10-22-task-approval-lifecycle.md) originally added
task-approval, task-approval-conflicts and task-approval-recovery, admitting only
registered project/task POST approve operations and exact counts. Historical
task-unapproval additionally admitted registered unapprove operations under the same
exact route, method and count checks. The
[lifecycle cross-layer extension](2026-10-22-task-lifecycle-cross-layer-acceptance.md)
owns the successor status annotations and strengthens the same underlying checks with a packed-CLI/ordinary-graph journey,
reviewed-version CLI/Web competition and SPA project isolation. It adds no
browser annotation or runner topology. Uncaught exceptions remain failures in
every scenario. Database
fault injection verifies the disposable database's ownership before changing it
and restores the resource in a finally path. Browser routing barriers control
response ordering separately from actual backend-failure observations.

The four complete API topologies retain their exact task and dependency inputs,
with five repetitions on the same IDs. Each has 1,000 tasks: chain has 999 edges,
merge/shared/external have 5,000, and external full context remains two main tasks
plus 998 ancestors. Complete API snapshots compare all inputs. The
[progressive overview decision](../feature/2026-10-22-progressive-task-graph.md)
changes DOM readiness to its bounded visible S and every real induced edge,
then checks explicit direct expansion/reset and exact counts. All-at-once
rendering is no longer the required browser workload. The
[automatic refresh decision](../feature/2026-10-22-project-task-auto-refresh.md)
extends freshness coverage and preserves native timers in capacity tests.
Test-side timer/fetch instrumentation attributes every project-sync request to
initial loading or the next fetch consumed after a periodic callback, including
the asynchronous IDB read before dispatch. Collapse/reopen must add no request
of its own. Complete task-graph reads remain independent correctness oracles.
Attachment and language isolation phases use a controlled browser clock for
exact operation counts, while scroll quiescence uses actual position samples and
a bounded test-process monotonic clock.

Five openings retain the 3,000ms click-to-painted operable-overview budget and
detail/zoom/pan feedback ≤300ms. The
[inspection delivery](../feature/2026-10-22-task-dependency-inspection.md) also
requires selection ≤300ms, complete H and deduplicated hidden-upstream checks.
Ordinary Details → close → immediate zoom/pan precedes trusted visible-task
selection and the highlighted sequence; each metric takes the slower state,
with network and layout/render timing separate and no close-to-zoom reset, Fit
view or extra wait. `visibility[5]` retains ordered overview/expansion/reset counts
plus selectedId/hiddenUpstream, requiring bounds, exact deltas and reset consistency.
Independent curved-route, actual paint/native-arrow, body coverage and dash-phase
oracles cover every visible edge and fixed port; graph-relative transforms keep
page scrolling separate from geometry stability. Capacity retains twenty
visibility/H rows and 160 feedback observations. Independent node/edge limits
still require complete 409 refusals. Current merged source needs its own real
native/container/capacity evidence; prior full-render or polyline runs do not
establish inspection or curved-route results for it.

Playwright runs one worker with zero retries. Report validation rejects global
errors, skipped/flaky/retried tests, duplicate/missing stable scenarios, missing
PNG screenshots and inconsistent summary counts. Native functional/capacity
reports form a strict twenty-nine-scenario union; container functional validation
requires twenty-four. Missing, extra or duplicate names fail both phase and aggregate
validation, and browser identity must agree across a target's phases.
Performance validation requires
all fixed datasets, exactly five valid measurements per dataset, every budget
and both independent limit receipts. CI also requires Linux, the Chromium version
pinned by Playwright 1.64.1 and a clean checkout whose Git SHA equals GITHUB_SHA.
Local browser overrides and dirty state stay explicit in local receipts.

Incremental schema 2 evidence records source/binary/database/browser identities,
pipeline stages, both runtime targets and their phases, raw Playwright reports,
screenshots, performance and dev-ci image/cleanup results in the project. The
capacity performance receipt retains its own schema 1. Each browser phase
verifies its process group and owned-browser cleanup before its successor;
capacity begins only after the other stages and full dev-ci cleanup finish. When selected, the web job archives browser
acceptance independently of the raw V8 coverage report; it remains dependent on
successful execution and cleanup. Go and web each retain strict unrounded total
statement coverage above 90%. The [module-scoped CI decision](../process/2026-10-21-module-scoped-pr-ci.md)
selects affected PR jobs without changing their internal gates; main pushes
retain all native CLI, shell completion, Go and web checks.

Timing begins at the trusted browser input event's performance-clock timestamp
and ends after the complete visible DOM/readable-root or feedback condition and two
animation frames. Event queue time remains included; automation actionability and diagnostic
snapshot work are excluded. All five repetitions and all original budgets remain
required. A bounded latest-root User Timing measure separates projection/Dagre
from subsequent rendering without a growing product telemetry history.

Each capacity dataset incrementally retains `feedbackDiagnostics` for every
interaction: trusted input, capture, first ready condition, first/second frame and
final end timestamps, status/error and phase differences. Missing milestones
remain null. The first condition/frame milestones do not replace the final end;
phase values are diagnostic observations, never deductions from the total budget.
Measurement failures and diagnostic/cleanup errors retain their joined causes.

One streamed CDP timeline/User Timing/frame/GC JSON trace per repetition correlates
those markers with browser work. The trace does not enable CPU sampling or CDP
screenshots; scenario PNG evidence stays separate. Bounded completion and resource
closure are required. Capacity tests disable Playwright's repeated DOM snapshots
and filmstrip. Authentication additionally disables Playwright action/network
traces because the pinned recorder captures credential headers and bodies;
the activation decision owns that privacy evidence and diagnostic cost. All
20 custom CDP traces, safe scenario PNGs and complete graph/geometry checks remain. Controller-side fixture,
snapshot and repetition durations identify harness costs separately from the
browser performance gate. The
[CI efficiency decision](2026-10-21-ci-validation-efficiency.md) records this
capture-work optimization and the choice to retain the unsplit suite. This is
test-side diagnosis for hosted zoom latency, without changing thresholds,
complete graph readiness or success rules.
Hosted traces show that earlier drawer-close raster/commit work can delay later
zoom frames even when the zoom handler is prompt. The budget still includes any
backlog visible after trusted input; work is not deducted because an earlier
interaction initiated it. Controlled raster ablations and pinned-engine evidence identify native dashing
of long oblique routes. The
[local-coordinate paint decision](../bug-fix/2026-10-20-long-dashed-dependency-paint.md)
retains native arrows, modal inertness and all canonical routes while changing
body paint. Production acceptance is delivered through
[PR #52](https://github.com/codetreker/daynight/pull/52); execution results remain
with the corresponding PR and CI.

Interrupted-run recovery checks that the original runner, callback/Playwright
processes and their owned groups have stopped,
then uses recorded Linux PID/executable/start-time identities, the native binary
hash and exact Docker ownership. Chromium has separate detached-group and
project-local profile marker receipts. Only confirmed groups/profiles are
reclaimed; ambiguous startup processes, orphan-only groups or unknown new
profiles fail recovery. A separate recovery result preserves the original
acceptance outcome and does not convert failed measurements into success.
Recovery accepts only top-level schema 2 evidence and validates stage command
identities/groups. It visits browser phases in reverse order: native capacity,
container, native functional. Browser CI outer recovery and its acceptance
artifact upload are tied to every attempted core invocation. The
[quality isolation decision](2026-10-26-web-quality-job-isolation.md) moves raw
coverage artifacts to the independent quality attempt without changing browser
recovery ownership.

The pinned Dagre optimization is validated separately from browser timing.
Exact differential checks in both ESM and CJS compare complete geometry with the
unpatched implementation under the same global longest-path policy, while
all-node/edge direction and overlap assertions preserve graph completeness.
The mandatory native `scripts/dagre.test.mts` reconstructs pristine bundles in
memory from the committed patch with published SHA-256 checks. The 23-fixture,
four-direction, three-ranker matrix compares complete coordinates, edge routes,
bounds and repeated geometry through both public exports; direct tie/removal and
usedBias cases protect the ordered scan semantics. Real-browser graph checks also
keep the task-card bounds and the static SVG routes aligned through the public
viewport portal. Every edge's identity, exact canonical Dagre points, native
arrows and pan/zoom transform remain asserted; native node measurement remains
enabled. The open/initial-ready count check includes the declared safe-integer
paint-piece count and actual body-piece DOM, in addition to every visible card/control and induced canonical route. Full
API input comparison stays independent of visible geometry. Independent CTM/arc reconstruction checks full ordered coverage,
phase continuity, gap-midpoint seams and native joins after the five timed
repetitions, adding no readback or idle wait between drawer close and zoom.
The [layout decision](../feature/2026-10-20-task-graph-projection.md) owns ranking,
normalization costs and the version-specific redundant-scan patch. Neither the
pure benchmark matrix nor geometry equivalence establishes arbitrary-DAG browser
latency; the full production gate still owns its fixed capacity verdict.

The [embedded deployment decision](../architecture/2026-10-20-embedded-dashboard-deployment.md)
owns production build and dev-ci resource topology. The
[architecture](../../../../docs/design/daynight-web.md) owns harness structure and
execution requirements. Source-bound browser artifacts and the corresponding PR
and CI run retain measured outcomes under the
[validation evidence decision](../process/2026-10-20-source-bound-validation-evidence.md).

## Alternatives

No alternative harness target architecture was selected. Rendering alternatives
belong to the [dashboard decision](../feature/2026-10-20-project-task-dashboard.md). The adopted
[MVP design](../architecture/2026-10-20-task-dashboard-mvp-design.md) already
requires real production targets, isolated PostgreSQL and independent strict
coverage. This decision specifies the evidence checks needed to enforce those
requirements rather than changing the application or deployment choice.

## Consequences

The browser gate requires Docker, Go and pinned Chromium in addition to Node/pnpm.
It takes ownership of temporary processes, database resources and a dev-ci run;
completion requires their confirmed cleanup. Raw and derived receipts are both
retained so a rounded percentage, exit code or summary cannot replace the
underlying measurement.

The pre-static-SVG local run passes both production targets, all fixed datasets
and repeat counts, independent limit refusals and cleanup/recovery. Its dirty
source identity is explicit. The first hosted shared-graph zoom measurement
exceeded 300ms; its failed result is retained. The single static edge SVG keeps
all original graph completeness and timing gates. Its new complete local native
and container run passes, including all fixed datasets/repetitions, independent
limits, SVG coordinate/endpoint alignment and cleanup/recovery. Later native-dash
SVG hosted runs exceeded the budget; the local-coordinate body fix is delivered
with production acceptance in PR #52. A separate
real-Docker matrix passes
startup/test-failure,
cancellation and cleanup-failure/recovery while a second stack retains its
HTTP/data sentinel. It predates the SVG change and tests unchanged deployment
lifecycle code, not the new UI image identity. Its final audit confirms no owned
resources or processes remain. That local manual matrix is distinct from CI's
controlled lifecycle and
production-browser suites. Historical preview and HTTP
smoke evidence remains labeled by its actual scope, and fixed-topology results
do not
establish arbitrary-DAG latency.
