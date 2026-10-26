# Agent Note: Bound Web callback initialization and execution separately

Status: implemented

## Problem

The native container-callback test measures readiness only after the child has
imported the acceptance runner and sent `initialized`. Its process watchdog
originally started at spawn and expired after five seconds, so module loading
still consumed the callback's execution budget. The
[initialization handshake](https://github.com/codetreker/daynight/blob/fc45e6fec506357cbe6eb1eec7895d8b7968ccf8/packages/daynight-web/scripts/acceptance/runner.test.mts#L244)
separated the readiness observer from import time but retained that shared
watchdog. A sufficiently slow initialization could therefore kill the child
before the callback received its own three-second readiness window.

The [main Web failure](https://github.com/codetreker/daynight/actions/runs/40055668107/job/120758124139)
reports the fixture's own timeout and `SIGKILL` during readiness publication. The
failure does not establish a transient infrastructure cause or justify rerunning
unchanged checks.

## Decision

The test gives only its IPC callback child a thirty-second initialization bound.
After observing `initialized`, the parent replaces that watchdog with a fresh
five-second callback bound before sending `run`. Other spawned test children keep
the existing five-second bound. Child close clears the active watchdog, and
failure cleanup still kills and joins the owned child before removing its files.
No production callback behavior, CI concurrency, or browser gate changes.

The callback retains its three-second readiness observation and one-second IPC
status deadline. Identity, exact Docker command count, permission-before-Chromium,
abort-reason propagation, absence of cancellation listeners and timers, and
confirmed process disappearance remain part of the same native journey. The
[acceptance pipeline decision](../../archived/testing/2026-10-21-web-acceptance-pipeline.md) records the
callback permission and resource-ordering choices retained here; this decision
owns the fixture's phase budgets.

A controlled native regression delays initialization by four seconds and callback
readiness by another two seconds. It observes both phase boundaries through the
real child IPC and readiness receipt, then exercises the same permission and
cancellation assertions. Parent monotonic observations must confirm at least
those delays and more than five seconds from spawn to readiness. Reinstating the
original five-second spawn watchdog without rearming preserves the harness API
and makes this regression fail from an actual watchdog kill during readiness. A
second real IPC child would exit normally fifteen seconds after `run`; it must
instead be killed by the five-second execution watchdog. This distinguishes the
callback bound from accidentally retaining the initialization allowance, with a
wide scheduling margin before the child's bounded fallback.

## Alternatives

**Keep one watchdog after adding the initialization handshake.** This bounds the
whole child but allows initialization to consume readiness time. The observed
handshake alone cannot preserve a full callback execution budget.

**Increase the shared watchdog for every child.** This may hide the callback
failure but changes unrelated command-test failure bounds and still assigns two
separate phases one residual budget. Only the callback's initialization gets the
larger bound; its execution keeps the original five seconds.

## Consequences

A hung callback import may now consume thirty seconds, while a callback hang
following initialization remains bounded by five seconds. Ordinary child tests
retain their existing failure latency. The delayed regressions add about eleven
seconds to the native fixture suite and exercise actual process cleanup without
installing or launching a browser.

The controlled regression and shared-watchdog negative control establish test
phase ownership on their tested source and native host. They do not establish
production-browser acceptance or current hosted CI success. Hosted results and
full Web verification remain separate source-bound evidence.
