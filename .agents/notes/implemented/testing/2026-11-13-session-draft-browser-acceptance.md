# Agent Note: Session Draft Browser Acceptance

Status: implemented

## Problem

Image drafts depend on browser mechanisms that module fixtures cannot fully
prove: IndexedDB transactions and reopening, Blob ownership, Web Locks,
cross-tab coordination, image decoding and input events. Their regression suite
needs an executable browser entry and retained evidence. Package installation
can fail before those assertions start, so an installation failure and a failed
draft assertion must remain distinguishable.

The original draft implementation added its browser suite to the former PR
browser job. The later
[shell/browser workflow decision](2026-11-12-shell-browser-workflow.md) moved
specialized acceptance to main pushes and manual dispatch, preserving its
complete suites while removing that work from the ordinary PR gate.

## Decision

The existing `verify-web-browser` job in
[`shell-browser.yml`](../../../../.github/workflows/shell-browser.yml) runs the
ordinary Session draft configuration after the assistant browser suite and
publishes a separate draft JSON report and failure artifacts. Its locked
Chromium installation, runner, toolchains and failure propagation remain intact.
The [explicit Web browser entry](2026-11-06-web-module-browser-entry.md) also
includes the ordinary draft configuration. Capacity cases retain their separate
configuration and do not enter either routine command.

PR `checks` keeps the current module, API integration and product E2E gates.
Passing that workflow does not claim that the specialized browser suites ran.
Draft browser evidence belongs to the revision and environment actually tested;
manual dispatch or explicit local execution can establish evidence before merge.

Ubuntu installation investigation remains source-bound evidence, without a
permanent general-purpose network collector in these workflows. The historical
investigation compared the runner, root and APT sandbox resolvers, direct HTTPS
and APT transport, and public DNS over UDP, TCP and HTTPS. Its short-lived
process-local HTTPS addresses retained certificate and hostname verification;
probes neither changed system resolver settings nor verified package signatures.
Selected resolver and APT observations excluded credentials and proxy values.
These observations helped distinguish possible failure layers but did not prove
an installation repair. Original evidence and uncertainties remain with their
execution artifacts.

Official signed package sources, required dependencies, the locked browser and
real test success remain requirements. Installation errors still fail their job;
removing a diagnostic collector cannot turn them into successful acceptance.

## Alternatives

**Retain the permanent multi-transport network collector.** Bounded observations
and uploads before installation can preserve evidence when tests never start.
They also add unrelated network dependencies, maintenance and execution time to
every shell/browser run, while a successful probe proves only that request at
that instant. No diagnosed repair requires the collector to ship with drafts.

**Change DNS settings or pin archive addresses.** An APT resolution error alone
does not identify the failed resolver path. Permanent resolver ownership or
address pinning needs evidence of the fault and a validated remedy; alternate
probe success does not establish either.

**Remove dependencies, replace Chromium or bypass the failing job.** These
choices change or weaken the verification environment without proving its
dependencies unnecessary. They do not restore the required acceptance result.

**Restore the former per-PR browser job.** This would reverse the independent
workflow's scheduling decision and add its preparation cost to every affected
PR. The existing main/manual workflow can host the draft suite without changing
that contract.

## Consequences

The draft suite shares the specialized browser job's preparation and remaining
time budget. Assistant failure can prevent later draft execution; artifacts
identify which suite actually started, and skipped draft work is not acceptance.
Capacity tests require an explicit separate run. Real browser mechanisms with
controlled service responses do not prove complete service/Worker/Provider
integration.

A future package failure may need a new bounded investigation. Adding such a
probe later does not require changing product draft storage or sending, because
installation remains a separate workflow step. Reconsider permanent diagnostic
tooling only when recurring evidence establishes a concrete maintenance benefit
and its own scoped ownership; do not infer a repaired network from a later
successful installation.
