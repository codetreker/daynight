# Agent Note: Concurrent Web Functional Targets

Status: implemented

## Problem

At the time of this decision, the production browser job ran the same complete
functional inventory against native and container deployments. In [run 41759820378](https://github.com/codetreker/daynight/actions/runs/41759820378/job/126344646908),
the two Playwright invocations took 307.595 and 303.352 seconds, while the complete
job took 14 minutes 17 seconds. Container preparation already overlaps native
preparation, but browser permission waits for native functional cleanup. That
places both browser durations on the critical path.

The deployments have separate databases, authentication fixtures and storage,
but their browser profile inventory and installed-CLI recovery share a run-wide
scope. Concurrent scheduling requires ownership that cannot mistake another
active target for a leaked resource or remove its credentials.

## Decision

The [single-target decision](2026-11-06-single-target-web-acceptance.md) replaces
concurrent native/container execution with one selected runtime per invocation.
Container is the default CI target; explicit local native/APFS/stress runs use
native. The permission handoff and dual-target pipeline no longer exist. This
record preserves the original concurrency rationale and the ownership choices
that remain useful for browser/CLI lifetime management.

### Original concurrency arrangement

The original implementation started both preparations and released the container
browser after native preparation had installed the shared CLI. Each deployment
kept one worker and zero retries. An atomic permission bound acceptance run,
dev-ci run and source SHA; a slow container announcement was awaited with
cancellation. The later [case-shard decision](2026-11-04-web-ci-case-shards.md)
partitioned CI functional selection and placed combined authentication on shard 2.

Separate phase-private profile roots prevented one target from classifying the
other's active browser as leaked. Playwright allocated profiles beneath those
roots, outside public artifacts, while Chromium used the short relative `.tmp`
socket directory to avoid Unix-domain socket path limits. Launch, inventory,
ownership and recovery used the same saved root and identity.

Each CLI invocation retained its process-group check and private client home.
Combined cancellation stopped its commands without recovering another target.
Run-wide CLI recovery waited until both targets drained, then optional local
capacity began after container/browser cleanup. This ordering preserved active
commands and credentials while concurrency was required.

### Retained ownership

The selected target still uses phase-private browser roots, verified process
identity, explicit CLI cancellation and a shared installed package until all
consumers finish. Capacity remains local-only, starts after functional/browser
and CLI cleanup barriers and retains its full data and timing budgets. A failure
must drain started work and preserve errors before final cleanup. The
[Web README](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns current commands, receipts and recovery.

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

**Create more CI jobs or a new handoff protocol.** At this decision, separate jobs
would duplicate production preparation and need additional source, artifact and
result coordination, while the existing targets could overlap within one job.
The later [case-shard decision](2026-11-04-web-ci-case-shards.md) accepts that
preparation cost for two case partitions, retaining the existing target receipts
and final gate rather than transferring runtime resources between runners.

**Optimize dependency and image caches first.** In the measured run, outer pnpm
installation took about 20 seconds and Docker Go compilation took 39.4 seconds.
These costs remain candidates for separate measured work, but they account for
less elapsed time than the two serial browser suites.

## Consequences

The original overlap removed the serial sum of two functional invocations but
retained duplicated work and resource competition. It did not alone prove a
hosted speedup; observed results remain bound to their source, workload and
runner. The single-target replacement accepts less routine native UI/runtime
coverage and removes the coordination that existed only for two active targets.

Private profile roots and cleanup barriers remain necessary within the selected
target's functional, combined-authentication and optional capacity phases. A new
concurrent target would require a separate decision about those ownership and
resource costs; the current receipt cannot represent an omitted target as passed.
