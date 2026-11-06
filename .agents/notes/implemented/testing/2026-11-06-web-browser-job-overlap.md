# Agent Note: Overlap Navigation and Production Browser Validation

Status: implemented

## Problem

At the original scheduling decision, the second Web browser job ran three
navigation suites before starting production acceptance. Navigation builds,
browser work and teardown formed a serial prefix although their fixtures did not
use the production targets.
Reducing an individual case does not establish a shorter CI job; execution
scheduling and complete resource lifetimes must be measured together.

Browser navigation can also overlap host networking changes if it starts while
Docker builds or services are being prepared. An initial unrestricted overlap
produced `ERR_NETWORK_CHANGED`; the available logs did not retain the exact
kernel event. Scheduling must provide a network-lifetime boundary without
relying on a navigation branch usually finishing first.

## Decision

Chromium and its OS dependencies finish installation before CI starts acceptance.
The shared-check owner requests navigation through an optional
`navigationChecks: true` in the existing run/source-bound parent evidence.
The field admits absence or literal true and is restricted to functional shared
checks. The container callback verifies the same intent when rereading its
parent after installed-CLI validation. The
[single-target decision](2026-11-06-single-target-web-acceptance.md) removes the
former dual-target permission wait. Direct
acceptance and the first shard retain their existing paths.

The callback overlaps two operations: three navigation commands run serially
in one branch, while the container functional browser runs in another. The
editor command runs its complete 28 cases; Team/Session and Bot commands select
20 and two `@routine` cases with `--grep @routine`. Their unfiltered local configs
retain the complete 136/nine cases under the
[single-target coverage policy](2026-11-06-single-target-web-acceptance.md).
Both branches settle before combined authentication can restart the container.
Only after authentication and callback exit can dev-ci remove its networks.
The selected container is the only production target in that invocation.
Navigation uses its existing request and callback, without a new cross-runner
artifact handoff.

Navigation uses ports 4193, 4194 and 4198, dedicated Vite cache/output directories
and browser-routed API fixtures. Every navigation command receives a copied
environment without the production `DAYNIGHT_ACCEPTANCE_DIRECTORY` marker;
explicit browser-channel and other tool settings remain intact. Production
browser recovery can therefore finish while a same-executable navigation browser
remains active, without claiming it as an unrecorded owned process. Navigation
does not write production build outputs or use production service databases.
Acceptance retains its run/phase-private
browser inventory, installed CLI receipts, credentials and process ownership.
The selected target keeps one-worker execution, source/image checks and actual
cleanup barriers. Scenario IDs, Playwright case sharding, canonical union and
once-only check ownership remain enforced.

A branch failure aborts the shared callback controller promptly. Both branches
drain before callback settlement, preserving distinct operation and cleanup
errors; the parent then completes its selected target's resource cleanup.
Existing command wrappers still require complete process-group termination.
Navigation cancellation escalates its owned command group after one second,
inside dev-ci's five-second callback termination grace. The navigation
verification deadlines remain 180, 540 and 180 seconds; this cleanup ordering
does not relax those checks. A real TERM-ignoring subprocess regression verifies
that callback cleanup joins the forced group before the outer grace expires.
The [single-target decision](2026-11-06-single-target-web-acceptance.md) owns the
production runner's target selection and removed duplicate preparation.

The [Web validation guide](../../../../packages/daynight-web/README.md)
owns commands and receipts. Validation measures the complete browser job and
its major phases under comparable resources, including the additional concurrent
navigation browser. Local scheduling tests prove ordering and error propagation;
real browser/deployment checks prove selected-target work and resource cleanup. Hosted
job measurements remain separate from constrained-container observations.

## Alternatives

**Keep navigation as a serial prerequisite.** This avoids extra concurrent CPU
and memory use, but delays independent production preparation and browser work
until all navigation hosts finish.

**Run navigation during all production preparation.** This overlaps the largest
prefix but allows Docker build/service networking changes during navigation.
The observed navigation failure makes that unrestricted schedule unsuitable.

**Await navigation before releasing container permission.** This keeps the
network alive, but puts navigation back before the critical container browser
branch and can retain the original critical-path sum.

**Increase workers inside a production target.** Cases share a target's database
and controlled fault state. More workers change that isolation boundary;
independent navigation hosts provide concurrency without sharing those states.

**Move cases between shards at the same time.** Repartitioning could reduce a
later imbalance but changes another variable. This change keeps the selection
and records which job becomes the workflow's critical path.

**Share artifacts across runners.** This introduces handoff dependencies and
ownership beyond the serial prefix. Existing source builds and per-run receipts
remain sufficient for this scheduling change.

## Consequences

The second browser job can overlap navigation with container functional work.
CPU, memory and I/O competition may lengthen either branch, so saved serial time
is only a model until whole-job measurements confirm it. Cancellation waits for
real cleanup, which can finish after the first error.

A shorter second shard may move the workflow bottleneck to the first shard or
Go validation. Job improvement and overall workflow improvement therefore have
separate evidence. No fixed speedup, cached test result or relaxed gate follows
from this concurrency choice.
