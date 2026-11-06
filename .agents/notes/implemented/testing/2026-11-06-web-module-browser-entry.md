# Agent Note: Web Module Browser Entry

Status: implemented

## Problem

Web behavior that depends on native browser layout, focus, history and selection
cannot be established by JSDOM. Separate frontend fixtures already provide
controlled API responses, but their independent commands do not give the module
one complete browser entry after removal of the cross-product acceptance runner.

## Decision

The Web module browser command runs each navigation Playwright configuration in
sequence. Each configuration owns its frontend host, browser contexts and API
fixtures. Fixed ports can be reused safely after the preceding command stops.
A failed, cancelled or timed-out command fails the entry. Playwright receives a
graceful stop; the runner checks marked preview processes and browser profiles,
reporting unverified or failed cleanup. A discovery test compares the entry with
the configuration files so that a new suite cannot silently remain disconnected.
The Web guide owns the command and its prerequisites. Unit/coverage, browser
and build checks remain separate. The [shared Team preview](2026-11-05-shared-team-navigation-preview.md)
retains its own per-project isolation and timeouts. The former
[browser job overlap](2026-11-06-web-browser-job-overlap.md) and
[prelaunch inventory](2026-11-05-browser-prelaunch-inventory.md) records retain
their historical rationale for the removed full-stack runner.

## Alternatives

**One shared Playwright configuration and preview.** Existing fixtures have
different hosts, routes, ports and timeouts. Combining them would change their
isolation and preparation contracts rather than simply making them discoverable.

**Keep only individual commands.** A maintainer can run a focused configuration,
but there is no complete module entry to detect an omitted browser suite.

## Consequences

The entry needs an installed Playwright browser and runs the existing suites
serially, including their separate preparation. Controlled fixtures establish
frontend behavior only; they do not prove a real service or cross-product flow.
A forced termination cannot prove cleanup of an arbitrary detached process that
has neither the invocation marker nor its browser profile. Windows orphan cleanup
is refused when identity cannot be verified.
CI's current Web quality job separately runs its configured assistant browser
suite; final cross-module CI integration has its own owner.
