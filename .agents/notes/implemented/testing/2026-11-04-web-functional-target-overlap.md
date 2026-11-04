# Agent Note: Concurrent Web Functional Targets

Status: implemented

## Problem

The production browser job runs the same complete functional inventory against
native and container deployments. In [run 41759820378](https://github.com/codetreker/daynight/actions/runs/41759820378/job/126344646908),
the two Playwright invocations took 307.595 and 303.352 seconds, while the complete
job took 14 minutes 17 seconds. Container preparation already overlaps native
preparation, but browser permission waits for native functional cleanup. That
places both browser durations on the critical path.

The deployments have separate databases, authentication fixtures and storage,
but their browser profile inventory and installed-CLI recovery share a run-wide
scope. Concurrent scheduling requires ownership that cannot mistake another
active target for a leaked resource or remove its credentials.

## Decision

Native and container functional targets overlap after native preparation has
finished preparing the shared installed CLI. Each target retains one Playwright
worker, zero retries and the complete functional and combined-authentication
inventory. The existing atomic container permission remains bound to its
acceptance run, dev-ci run and source SHA; its phase identifies completed native
preparation. A slow container announcement is awaited with cancellation rather
than treated as failed native preparation.

Every browser phase derives its profile root under the run's private acceptance
directory. Launch, inventory, profile extraction and recovery use the same root.
Profiles stay outside uploaded acceptance artifacts, including on failure.
Recovery still rejects unknown profiles and changed process identities within
that phase; another active phase has a separate root. Playwright's parent uses
the private root to allocate profiles, while the Chromium child retains the
short relative `.tmp` socket directory. Using the full private path for Chromium
socket creation exceeds Unix-domain socket path limits even in a short checkout.
The explicit profile argument still points to the private phase root.

Each CLI invocation retains its own process-group check and private client home.
Combined authentication passes cancellation to its CLI commands so cancellation
stops those commands without recovering another active target. Run-wide CLI
recovery happens after both functional targets have drained, before optional
local capacity. Unconditional final recovery remains responsible for failures.
The shared installed package remains available until all consumers finish.

The optional capacity phase remains local-only and starts after both functional
targets, container teardown, browser recovery and the shared CLI barrier. Failure
propagation and draining remain required before final resource cleanup. The
[Web README](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns the runtime contract. This supersedes the native-before-container browser
ordering retained by the [quality isolation decision](2026-10-26-web-quality-job-isolation.md),
without changing that decision's separate quality job or command budgets.

## Alternatives

**Increase workers within a target.** Functional fault cases rename shared
database tables, and profile-layout cases temporarily change shared account
profiles. They cannot run concurrently against one deployment without changing
their fixture isolation. Separate deployment targets already isolate those
business resources.

**Release container permission without changing cleanup.** A browser phase would
reject another phase's new profile, and run-wide CLI recovery could terminate
its commands or delete credentials. Scheduling depends on private profile roots
and the shared cleanup barrier.

**Create more CI jobs or a new handoff protocol.** Separate jobs duplicate
production preparation and need additional source, artifact and result
coordination. Existing in-job targets and receipts provide the needed isolation.

**Optimize dependency and image caches first.** In the measured run, outer pnpm
installation took about 20 seconds and Docker Go compilation took 39.4 seconds.
These costs remain candidates for separate measured work, but they account for
less elapsed time than the two serial browser suites.

## Consequences

The critical path can overlap the complete functional targets while keeping
failures, source identity and cleanup observable. The job still performs the
same verification and uses its existing artifact and recovery entry points.
Concurrent functional work can contend for runner resources; a scheduling change
alone does not prove a hosted speedup. Before/after results belong to the tested
PR and CI runs, and variation between hosted samples limits causal claims.

Private profile roots and a shared CLI barrier become required scheduling
constraints. Any later additional target must preserve those ownership and
cleanup rules. Local capacity remains isolated from active functional work.
