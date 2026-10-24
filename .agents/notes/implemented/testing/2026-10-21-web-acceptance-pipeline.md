# Agent Note: Web Acceptance Pipeline

Status: implemented

## Problem

Preparing a cache-only production build and later invoking the normal dev-ci
build repeats work on the web critical path. Waiting for every preparation step
before browser work also serializes independent native and container setup.
Increasing overlap must preserve complete production validation and keep
capacity timing free of competing builds, coverage and container cleanup. Network-
dependent browser downloads must also stay outside the five-second UI-test
deadline, while installation and coverage retain bounded command deadlines.

The preceding optimizations and stability work are delivered through
[PR #70](https://github.com/codetreker/daynight/pull/70) and
[PR #71](https://github.com/codetreker/daynight/pull/71). The
[post-PR #71 main run](https://github.com/codetreker/daynight/actions/runs/39545046061)
at `0a1510aa1af9482c7670a09c67096bbd391041a2` passed its complete workload in
4 minutes 28 seconds. Main run
[39785915428](https://github.com/codetreker/daynight/actions/runs/39785915428)
later failed in browser preparation: Playwright's apt phase needed 4 minutes 56
seconds to download 25.9 MB, while the command had a 180-second deadline. PR run
[39788510354](https://github.com/codetreker/daynight/actions/runs/39788510354)
showed the same package set taking 8 minutes 31 seconds. PR run
[39791820767](https://github.com/codetreker/daynight/actions/runs/39791820767)
then spent 13 minutes 17 seconds fetching 23.1 MB from the Azure archive and
exceeded its 600-second install deadline. [PR #148](https://github.com/codetreker/daynight/pull/148)
selected official Ubuntu archives to remove that slow mirror from hosted
preparation. PR run
[39794986474](https://github.com/codetreker/daynight/actions/runs/39794986474)
then fetched 25.9 MB of apt packages in 7 seconds, downloaded Chromium in about
10 seconds under the original 180-second bound, and passed the complete web
acceptance. The first main run after that fix,
[39798535790](https://github.com/codetreker/daynight/actions/runs/39798535790),
fetched 5.8 MB and 21.1 MB apt package sets in 5 and 3 seconds. During coverage,
Playwright downloaded a 191.1 MiB Chromium archive while the 5-second progressive
graph-visibility test timed out. The test failure was reported as the download
reached 80%; the browser download then completed. These logs show that
network-heavy browser preparation overlapped the timing-sensitive test; they do
not isolate whether CPU, I/O or another shared-runner resource caused the timeout.
The updated pipeline then ran in
[39801658628](https://github.com/codetreker/daynight/actions/runs/39801658628):
coverage passed before browser preparation, but the official archive needed 1
minute 59 seconds to fetch 12.5 MB of package indexes and 2 minutes 43 seconds to
fetch 25.9 MB of dependencies. The original 180-second deadline expired during
the second transfer; no Chromium download began. This run confirms that coverage
must finish first and that the browser-install deadline must accommodate the
measured Linux dependency transfer even after the archive source changed.
The next head,
[549d55c](https://github.com/codetreker/daynight/commit/549d55ca39e513ea47816d4d79fa260442f77fdb),
passed in PR run
[39803676876](https://github.com/codetreker/daynight/actions/runs/39803676876)
on tested source `f2b4bc82017400fa38687d3c04dbc3191e9e1bee`. Coverage passed
before browser preparation; browser installation began immediately afterward
and completed in 26.7 seconds. Native/container functional phases, native
capacity, the standalone attachment persistence check and cleanup all passed.
This fast run validates the complete updated pipeline; it does not bound future
archive or browser download latency below the 600-second command deadline.
Main run
[39804920251](https://github.com/codetreker/daynight/actions/runs/39804920251)
on `f3a836161ad2d28b28642e6916fd2549fa79fb0a`, after
[PR #153](https://github.com/codetreker/daynight/pull/153), later failed the same
5-second progressive graph-visibility test while Playwright downloaded its
191.1 MiB Chromium archive. Apt transfers finished in 7 seconds and 8 seconds
for 12.5 MB of package indexes and 25.9 MB of dependencies. These repeated
timeouts support keeping browser downloads outside coverage, though their
timestamps do not identify the exact shared-runner resource that exceeded the
test deadline.

PR run 39803676876 used a merge checkout based on main `2ffce48`, before main
advanced to `f3a8361`; the later main failure keeps the browser/coverage overlap
relevant after that successful full acceptance.

## Decision

The [status assignment decision](../architecture/2026-10-24-task-status-assignment.md) owns the current three-state
protocol. Status journeys use exact registered PUT status writes; current
inventory is 33 native and 28 container results. The rollout counts below retain
their original delivery context; repeatable current commands and mappings belong
to the Web README.

One acceptance runner owns the fixed dependencies of the complete web job,
without shards. `scripts/acceptance/runner.mts` exports `runAcceptance`,
`runContainerCallback` and `recoverAcceptance` without starting work or registering
signal handlers on import. The thin `scripts/acceptance.mts` CLI and `scripts/ci.mts`
pass explicit cancellation controllers to that runner. CI supplies callbacks for
pinned Chromium installation and test preparation through the runner's coverage
callback. Package `test:harness` owns all Node acceptance/tooling harness tests; `test:coverage` owns the complete
Vitest/V8 suite and strict statement checker. Package `test` and root `web:test`
compose both serially. CI uses the same two canonical commands serially, each
bounded at 180 seconds, so the harness cannot consume the Vitest/coverage budget.
Neither phase may be skipped, and a failure or timeout prevents acceptance.
Only the `test:coverage` child receives `VITEST_MAX_WORKERS=2`, retaining its `forks`
pool and per-file isolation. The callback passes a copied environment to that
child rather than changing `process.env`; the harness, browser installation,
native preparation and dev-ci callback do not inherit the coverage-only worker
limit. Browser installation, including Playwright's Linux dependency installation,
has a 600-second deadline. The web job retains its 20-minute overall timeout.
Controlled deployment fixtures run before the unified CI entry. This partially replaces the cache-only preparation and target
sequencing of the [CI efficiency decision](2026-10-21-ci-validation-efficiency.md)
and the original schedule of the
[dashboard acceptance decision](2026-10-20-dashboard-production-acceptance.md).
Their real targets, complete scenarios, coverage, performance and cleanup
requirements continue to apply.

The runner starts the serialized test preparation, native production
UI/Go/PostgreSQL preparation, container callback and normal dev-ci source
build/start concurrently. Browser and Linux dependency installation starts only
after both test phases pass, removing apt and browser downloads from the 5-second UI-test deadline. Browser installation still
overlaps native and dev-ci preparation. The existing shell runner remains
authoritative for the unique image, running-image check and full stack cleanup.
Native functional browser work waits only for the native process, shared installed
CLI and browser preparation. Its twenty-nine scenarios and immediate browser
recovery must pass before the runner releases the container browser.

If either test command or another active phase fails while browser preparation
is waiting, the pipeline marks cancellation and the browser callback checks it as
soon as test preparation drains; it never starts the installer. The
[pipeline regressions](../../../../packages/daynight-web/scripts/acceptance/pipeline.test.mts)
verify coverage-before-browser ordering, cancellation while waiting, continued
native/container overlap, browser-install failure handling, and capacity after
full container cleanup. Their completion observer records rejection before
controlled failures are released, so teardown waits do not leave a rejected
pipeline promise unobserved.

Release is an atomic `container/container-permission.json` receipt with schema 1,
phase `native-functional-cleaned`, acceptance run ID, dev-ci run ID and source
SHA. The container callback records its process identity before waiting and
inventories browsers only after validating that exact permission. Its
`ready.json` records diagnostic timing and grants no permission. The callback
runs the twenty-four container functional scenarios, confirms browser cleanup and
returns to the normal shell exit path. The outer stage waits for full dev-ci
cleanup and browser recovery before completing. The native callback fixture
uses separate initialization and execution watchdogs while retaining strict
readiness, status, permission, and cleanup checks; the
[callback phase-budget decision](2026-10-24-web-callback-phase-budgets.md) owns
that test-only timing boundary.

Capacity runs last, after every preparation/check command, native functional
phase, container functional phase and complete container cleanup. The native
Go process and PostgreSQL remain alive for this final phase. One browser worker,
zero retries, all four fixed graphs with five repetitions, both independent
limits, complete visible induced geometry, twenty CDP traces and all original
timing gates remain required. Native functional and capacity phases strictly
aggregate to twenty-nine unique scenarios; the container target requires twenty-four.
Per-phase and aggregate validation reject missing, extra or duplicate scenarios
and retries, and require matching browser identity within a target.

The [progressive overview decision](../feature/2026-10-22-progressive-task-graph.md)
retains those complete API inputs and existing timing thresholds while requiring
bounded overview DOM, all induced visible edges and explicit expansion/reset.
Phase ownership and the original thirty-one-scenario inventory were unchanged
by progressive graph delivery. Authentication added six functional scenarios per
target and [Markdown description](../architecture/2026-10-22-task-description-markdown.md)
added one, producing the earlier forty-five-result inventory. The
[approval lifecycle](../feature/2026-10-22-task-approval-lifecycle.md) added three
approval scenarios per target. The historical
[withdrawal decision](../feature/2026-10-23-task-unapprove.md) added one functional
scenario per target. At that delivery the inventory was twenty-four functional per target and
five native capacity/limit scenarios: twenty-nine native and twenty-four container,
fifty-three in total. Normal UniAuth session/PAT bootstrap
uses private run-owned credentials; graph/read-only policies apply after bootstrap,
and the original approval journeys admitted only their registered task POST operations.
Current status journeys use the exact PUT allowlist described by the successor.
Capacity retains twenty visibility/H records and 160 feedback observations, eight
per sample, including full upstream/hidden-count checks and independent smooth-route,
actual paint and native-arrow checks. The 50/100 overview, explicit twenty-neighbor
expansion, no-autoexpand inspection rule and strict opening/selection/local-feedback
budgets are unchanged; their detailed requirements belong to the
[inspection requirements](../../../../docs/spec/daynight-task-inspection.md).

The pipeline originally introduced top-level schema 2. The
[macOS acceptance decision](2026-10-22-macos-web-acceptance.md) advances current
evidence and recovery receipts to schema 3 with platform and storage identity. Pipeline stages record
names, results, timestamps, observed managed-command process identities and their
spawned process groups. Short-lived commands retain their observed group without a
fabricated process identity. Identity lookup treats both ENOENT and ESRCH as an
absent process: Linux can return ESRCH when a descriptor opened before process
exit is subsequently read, as described by the
[pinned proc documentation](https://github.com/torvalds/linux/blob/a804c5742bff224d4cb4d25dd383554d598be32b/Documentation/filesystems/proc.rst#L121-L127).
Other filesystem errors remain failures. A regression interposes the actual
open/exit/read sequence rather than relying on scheduling luck; permission
failures retain their original error object. Target aggregates contain `phases`
and `scenarios`; each browser phase records its functional/capacity kind,
timestamps, actual Playwright process/group, browser identity and `browserCleanup`.
Raw phase data lives under `native/functional`, `container` and `native/capacity`;
capacity `performance.json` retains schema 1. Top-level schema 1, schema 2 and unknown
versions are rejected rather than interpreted through a compatibility fallback.

Any task failure cancels siblings and drains every started task before final
cleanup; an unexpected native-server exit follows the same path. Browser phase
cleanup verifies actual process groups and owned profiles immediately. Final
and interrupted-run recovery examine browser phases in reverse order, then use
the existing exact native-process and Docker ownership checks.

Installed-CLI recovery first verifies the recorded leader and discovered owned
members before sending SIGTERM to the recorded group. Each of the existing two
50-attempt, 100ms polling phases completes only when no owned members remain and
`kill(-PGID, 0)` reports ESRCH for that original group. Empty `/proc` ownership
results or an absent executable do not prove that the group has disappeared:
an exited child can await its parent's reap while the kernel still reports the
group. Both conditions are awaited within the existing budget. Remaining owned
members retain the exact identity check before SIGKILL. An initially live group
with no verified owned members still fails immediately; EPERM and other probe
errors propagate. Recovery neither signals an unidentified group nor treats
process-discovery absence as cleanup success.

A controlled real-kernel [reproduction](../../../../packages/daynight-web/scripts/acceptance/installed-cli.test.mts)
exercises this exit/reap interval through `recoverCliProcesses`. Its supervisor
holds the parent event loop before reaping. A successful group-existence probe
does not order the child's exit, so the fixture observes `/proc/<PID>/stat`
until the same start identity and process group report state `Z`, within its
existing five-second observation deadline. It then proves recovery remains
unsettled until the supervisor can reap the child and the original group is
absent. Identity mismatches and observation errors fail the test; the fixture
does not replace this kernel-state observation with a delay or extend recovery's
polling budget. The hosted failure that motivated the original repair retained
no child-state observation, so the reproduction establishes the mechanism without
asserting that the CI child was a zombie. The browser-install timeout and ordering
decisions do not alter command cancellation or recovery semantics; the broader
process-discovery and privileged-permission questions in
[issue #86](https://github.com/codetreker/daynight/issues/86) remain separately
tracked.

CI recovery and both artifact uploads share the unified acceptance step's
attempted-execution condition, so partial preparation remains attributable and
recoverable.

The [web README](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns commands and evidence interpretation. The
[attachment acceptance decision](2026-10-21-task-attachment-cross-layer-acceptance.md)
adds one shared installed CLI and one same-data attachment scenario per functional
target; it retains this schedule and the original capacity scenarios. The later
[task view decision](../feature/2026-10-22-project-task-views.md) adds
`project-view-tabs` to both functional targets without changing phase ownership
or capacity isolation. The
[complete context decision](../feature/2026-10-22-complete-prerequisite-context.md)
adds the dense-external capacity graph while preserving that isolation. The
[bilingual interface decision](../feature/2026-10-22-web-bilingual-interface.md)
adds three functional scenarios per target, preserving phase ownership, strict
aggregation and all capacity conditions. The
[lifecycle cross-layer extension](2026-10-22-task-lifecycle-cross-layer-acceptance.md)
reuses the installed CLI and existing approval annotations for same-data lifecycle
proof. Required source.gitTreeSha joins the existing callback/recovery identity
checks; phase permissions, scheduling, capacity isolation and cleanup ownership
remain here. The
[web design](../../../../docs/design/daynight-web.md#验证与-ci) owns mechanisms.
Authentication also keeps ordinary Playwright action/network tracing off to avoid
capturing credential headers/bodies; custom CDP performance diagnostics, PNG
oracles, strict raw validators and budgets remain. The activation decision owns
that source-verified privacy tradeoff and private fixture cleanup. Measured
outcomes remain tied to their source, environment and PR/CI run.

## Alternatives

**Run browser preparation concurrently with coverage.** This hides some setup
time, but main run 39798535790 timed out a 5-second progressive visibility test
while Playwright downloaded Chromium. Waiting for coverage isolates those tests
from browser downloads and still overlaps browser setup with native and dev-ci
preparation.

**Keep the 180-second browser-install deadline.** PR run 39794986474 passed with
the official archives under that bound, but the later main run 39801658628 needed
4 minutes 42 seconds for apt index and dependency transfers from the same official
archive. The command timed out at three minutes before Chromium installation
started. A 600-second command deadline accommodates this measured preparation
while preserving the web job's 20-minute overall limit.

**Wait for all preparations before starting browser installation.** This would
also separate browser downloads from coverage, but would serialize independent
native and dev-ci work. Waiting only for coverage protects the short UI-test
deadline while retaining the other preparation overlap.

**Remove `--with-deps` in CI.** This avoids apt work but leaves the runner without
the Linux libraries and fonts that Playwright prepares for Chromium. Browser
acceptance would depend on incidental runner-image contents rather than an
explicit environment requirement.

**Keep the Node harness and Vitest/coverage under one command deadline.** Their
combined duration lets successful harness work exhaust the budget available to
otherwise progressing Vitest suites and the strict checker as tests accumulate.
The phases have independent tools and completion conditions, so separate bounded
commands preserve the complete workload and expose the failing phase without
expanding the overall job or individual UI-test deadlines.

**Increase the whole job timeout.** That expands the deadline for every CI phase
and does not remove shared-runner contention during coverage. The existing
20-minute cap is retained; browser preparation is bounded at 600 seconds, and
the serialized harness and Vitest/strict-checker phases each have a 180-second
command bound.

**Keep cache-only preparation followed by a later normal build.** This allowed
preparation overlap without changing deployment ownership, but scheduled a second
production-build invocation and delayed native work until all preparation ended.
Starting the authoritative normal dev-ci build early preserves the same image
and cleanup checks while removing the duplicate preparation path.

**Overlap capacity with coverage, builds or container cleanup.** That can reduce
elapsed time but changes CPU conditions for the strict browser performance gate.
The fixed pipeline overlaps functional work and preparation, then waits for all
competing work and full stack cleanup before capacity.

**Shard the job.** Additional runners duplicate setup and require independent
identity and report aggregation rules. The adopted scope excludes shards and
retains one complete job with explicit phase dependencies.

**Stop waiting when owned-process discovery becomes empty.** The discovery scan
can lose executable/environment ownership data before the parent reaps an exited
child. Returning then makes a final group probe race with reaping. Polling both
absence conditions preserves the original cleanup requirement and deadline.

**Introduce a generic scheduler or pass previously built binaries between
entries.** These add scheduling configuration or artifact-identity rules beyond
the fixed acceptance dependencies. Both entries instead call the same runner,
which builds fresh native artifacts and owns their exact identity and lifetime.

## Consequences

Both test phases complete before the network-dependent browser preparation
begins, while test and browser preparation continue to overlap native service and
dev-ci preparation. The official Ubuntu archives selected by PR #148 replace the slow Azure mirror, though run
39801658628 shows that transfers from the official archive can still take several
minutes. The 600-second browser-install bound accommodates the measured 4-minute-
42-second apt phase. Harness and Vitest/strict-checker commands are separately
bounded at 180 seconds, and the complete web job remains bounded at 20 minutes.
A slower install that exceeds its command bound fails acceptance rather than extending CI without limit.

The normal dev-ci runner keeps its existing public interface, production image
checks and targeted cleanup. The native service lives longer because both native
browser phases use the same verified process and database. Phase separation adds
explicit permission and recovery evidence. A complete result requires every
phase, strict scenario union, matching browser identities and cleanup, not merely
successful child exits. Hosted CI remains the authority for full acceptance;
local validation and historical main runs retain their own source and environment
limits. Run 39801658628 proves coverage-before-browser ordering and the install
deadline failure path, but did not reach browser scenarios. PR run 39803676876
passed the complete production acceptance and cleanup under the updated ordering
and 600-second install bound. Archive transfer latency still varies by hosted
run, and the command and overall job deadlines remain failure bounds.
