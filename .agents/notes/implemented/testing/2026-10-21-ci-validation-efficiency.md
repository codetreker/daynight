# Agent Note: CI Validation Efficiency

Status: implemented

## Problem

Full CI waits for its slowest selected job even when every module job already
runs concurrently. The installed-command deadline probes originally required a
real five-minute operation timeout, imposing a lower bound greater than a
four-minute workflow target. Other validation spends time rebuilding the same
inputs, serializing isolated service scenarios, repeatedly traversing the
growing ancestor chain during fixture creation and capturing complete browser
DOM snapshots outside measured user interactions. Reducing that cost
must preserve caller-visible behavior, full capacity data, coverage and cleanup.

## Decision

Optimize work within the existing job families without shards. Module
selection, native platforms, installed suites, real Go/PostgreSQL workflows,
production container checks, fixed graph topology and repetition counts retain
their existing scope. Strict Go and web coverage thresholds, browser performance
budgets, failure handling and resource ownership remain required.

Native CLI CI typechecks and builds once, then runs the ordinary and installed
Vitest configurations directly against that compiled output. Standalone
`pnpm test` and `pnpm acceptance` retain their self-contained builds. Both
Go-consuming jobs restore module and compiler caches using the server `go.sum`;
the server gate still expires test results before real database, race and
coverage observations.

Web execution follows the
[acceptance pipeline decision](2026-10-21-web-acceptance-pipeline.md), which
partially replaces this decision's cache-only preparation and serial target
schedule. The original optimization ran pinned Chromium installation,
`pnpm web:test` and a default-builder cache-only Dockerfile build concurrently,
then performed full acceptance. This overlapped preparation without changing the
normal dev-ci image checks, but still rebuilt that production path later and
waited for all preparation before native browser work. Its coverage child gained
a two-worker budget with the existing `forks` pool and file isolation to provide
contention headroom. Those adopted steps and their stability refinement remain
attributable to [PR #70](https://github.com/codetreker/daynight/pull/70) and
[PR #71](https://github.com/codetreker/daynight/pull/71); their historical CI
results retain their tested source and do not establish a later pipeline's
behavior. The replacement keeps that child budget and all acceptance gates while
using one early normal dev-ci source build and delaying capacity until other
browser work and container cleanup have finished. The later
[quality isolation decision](2026-10-26-web-quality-job-isolation.md) gives quality
and browser acceptance separate runners and 20-minute job bounds, keeping the
complete browser journey together. The historical two-worker comparison below
remains evidence for that worker budget, not a guarantee about later hosted
duration.

Native Git fixture reuse extends the existing per-file immutable bare seed.
Sparse suites prepare their shared source graph and refs once before copying;
every case retains its private upstream, initial-to-sparse SQLite observation,
real manager operations and filesystem snapshots. Version checks share only the
default parentless `1.0.0` base objects; all scenario commits and refs, special
prerelease roots, missing-object cases and unrelated histories remain private.
No same-file concurrency or worker override is introduced. The
[Git validation decision](2026-10-18-parallel-git-validation.md) owns seed and
mutable-subject isolation.

This partially replaces the wall-clock requirement of the
[installed project/task acceptance decision](2026-10-20-installed-project-task-acceptance.md).
That decision originally sought evidence for the exact public deadline duration,
which explains its real five-minute probe. Deadline behavior now uses meaningful
short test values while production defaults remain separately asserted. A
Node.js `registerHooks` preload wraps only the exact installed
`api/operation.js` module, re-exports its original implementation and error
classes, and invokes `createOperation` with a 3-second total and 1-second request
deadline. It first asserts the installed defaults of 300,000/30,000 ms and
128/256 MiB. Node receives the preload through an encoded file URL, preserving
module resolution for Windows drive letters, spaces and Unicode paths. The
installed files, production source, CLI parameters and runtime configuration are
unchanged.

The stalled-response probe still receives headers and an incomplete JSON body
before waiting for the request deadline. The total-deadline probe still makes
sustained valid progress through unique cursors, with individual pages finishing
inside the request budget. Both require the intended deadline diagnostic, empty
stdout, actual elapsed test deadline and confirmed cleanup. The other four
probes do not load the mock: legal gzip JSON reaches the exact decoded 128 MiB
single-response and 256 MiB cumulative limits, and each limit plus one byte is
rejected. Each probe receipt records its actual `totalMs`, `requestMs` and
`mocked` status. A short-deadline pass establishes the behavior under those
values, not a real five-minute elapsed observation.

Independent built-process service scenarios use at most four active subtest
slots within their sequential top-level test. Each scenario retains its schema,
server and CLI processes, database barriers, receipt entry and cleanup. Waiting
for parallel subtests before the parent returns keeps other top-level tests'
process-wide environment changes outside that lifetime. This refines the
[built-process acceptance decision](2026-10-19-server-process-acceptance.md)
without replacing package-level transaction, snapshot, race or coverage tests.

Capacity fixture construction retains real public write APIs and the fixed
complete graph. The chain first creates its 1,000 nodes without dependencies,
then attaches the 999 edges with versioned PATCH requests from the final indexed
task toward the root. Each referenced predecessor is still independent when the
server checks for cycles, avoiding repeated traversal of the growing chain.
The fixture replaces each task with the actual PATCH response, retaining current
versions and fields. Complete API snapshots compare every node's dependencies
against the fixture, and the chain also asserts the exact predecessor sequence.
All five timed repetitions use the completed graph unchanged.

Capacity browser tests keep one worker and zero retries. They disable
Playwright's repeated DOM snapshots and filmstrip, retaining all per-repetition
streamed CDP timeline traces, scenario PNGs and complete node, route and
paint-geometry checks. The later
[authentication activation](../architecture/2026-10-22-authentication-activation.md)
disables Playwright action/network traces because the recorder includes raw
credential headers and bodies. That diagnostic/privacy choice leaves these
custom traces and performance assertions intact. Controller diagnostics record
fixture creation, snapshot validation and each repetition's interaction and
total duration separately from browser input-to-feedback timing. The
[dashboard acceptance decision](2026-10-20-dashboard-production-acceptance.md)
continues to own the required production targets, fixed datasets, five complete
repetitions and performance budgets.

Test queries reuse results and search the smallest known control region. The
51-project pagination case controls both HTTP page promises, verifies the
disabled loading button and retained 50 items before releasing the second page
inside awaited `act`, then synchronously checks all 51 ordered accessible names,
deduplication, links and the final state. It reuses the complete heading array
for link assertions and retains the five-second outer test bound. Capacity
interactions find the dialog by role within the backdrop, its close button within
the header and the zoom button within the canvas controls. Exact button
roles/names, trusted click actionability, dialog visibility/removal and
all original node, geometry, timing and trace checks remain required. This
removes repeated whole-document accessibility traversal without relaxing test
timeouts or acceptance budgets.

The production container path retains its full build, image identity checks,
functional scenarios and cleanup under the existing
[embedded deployment decision](../architecture/2026-10-20-embedded-dashboard-deployment.md).

The [repository validation guide](../../../../README.md#validation) and package
READMEs own commands and receipt interpretation. Run-specific timings, source
identities and cold/warm-cache observations belong to the corresponding PR and
hosted CI run. The four-minute goal requires observed hosted workflow duration;
local speedups or the removal of a five-minute wait do not establish that goal.

## Alternatives

**Retain the real default-duration probes on every run.** This proves the exact
elapsed production duration but imposes a five-minute floor before installation,
coverage and cleanup. The original real-duration observations remain historical
evidence with their original tested source. Separate default assertions and
short-deadline behavior tests remove that floor without changing runtime values.

**Move long probes to scheduled or release-only CI.** This reduces PR latency but
splits the required evidence across schedules. Short test deadlines allow the
same six installed resource-budget scenarios to remain in each selected Go job.

**Prepare the browser, unit checks and Docker layers serially.** These stages
have no shared mutable test subject or dependency on each other's output.
Serial execution adds their elapsed times to the web critical path. Concurrent
preparation retains the exact browser/unit commands and the production
Dockerfile, waits for every owned command and keeps the later browser
performance workload isolated from preparation work.

**Export and restore a local BuildKit cache across CI runners.** An isolated
cold/warm builder experiment measured substantial warm-cache rehydration and
export overhead with a large exported cache. Its warm build did not demonstrate
a net improvement over the observed ordinary Docker build, before accounting for
GitHub cache download/upload and builder setup. Adding a cache interface,
ownership lock and interrupted-export recovery would introduce maintenance cost
without established workflow savings. Keep the existing complete container path;
reconsider only when a hosted comparison includes setup, transfer, build, export
and cleanup and demonstrates a net benefit for the same production workload.

**Shard browser or Windows suites.** Additional runners were considered for
shortening the critical path, but duplicate setup, consume more total compute
and add report aggregation obligations. The adopted scope excludes shards and
continues optimizing the existing complete job families.

**Use automatic or single-worker sizing for concurrent web preparation.** A
controlled four-CPU comparison combined complete coverage with an uncached Docker
build. Two Vitest workers preserved joint elapsed time relative to the default
three-worker run, while one worker took longer. The two-worker child budget
therefore provides contention headroom without changing pool isolation or test
coverage. This local comparison does not establish a universal faster setting
or a hosted timing result.

**Keep attaching chain dependencies during forward node creation.** This uses
fewer write requests but makes cycle validation repeatedly traverse an expanding
ancestor chain before any browser measurement. Creating independent nodes and
attaching edges from sink to root adds real PATCH requests while preserving the
final topology, public API validation and current versions at lower setup cost.

**Reduce graph size, repetitions, byte limits or coverage gates.** This would
change the supported workload or acceptance claim. The selected optimizations
remove waiting and diagnostic duplication while preserving those tested limits.

## Consequences

Installed deadline probes take seconds rather than minutes and explicitly expose
their mock scope in evidence. Service concurrency can use spare CPU and database
capacity, while the four-slot bound limits contention. Browser capture removes
repeated large DOM serialization without changing timed input, complete-canvas
readiness or failure criteria.

The test-only loader depends on Node.js 24 and the installed module location;
fixture tests must fail when the target or default assertions no longer match.
It deliberately exercises the original operation implementation rather than a
separate mock implementation. Byte-boundary probes and real-service behavior
remain independent of that loader. Hosted runner contention and cold builds can
still affect overall duration, so completion against the four-minute goal must
be judged from complete hosted runs and their actual workload.
