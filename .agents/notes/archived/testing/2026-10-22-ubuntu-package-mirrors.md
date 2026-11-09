# Agent Note: Official Ubuntu archives for hosted acceptance

Status: implemented

## Problem

Hosted shell and browser acceptance can exhaust their fixed preparation limits
while the runner's preferred Ubuntu package mirror transfers dependency packages
slowly. These failures happen before the real shell editor or browser scenarios
start. Repeated executions consume the same dependency path and do not establish
that the workload is valid.

The Ubuntu runner image configures a local mirror list with Azure HTTP as the
first candidate and the official HTTPS archive and security services as later
candidates. Its existing retry and inactivity-timeout settings do not impose a
minimum transfer rate. The source-bound failures and their dispositions remain
with their CI runs; the mirror mechanism is visible in the pinned runner
[source configuration](https://github.com/actions/runner-images/blob/7e7dc1bcc0ef464e5e315a2b4c33609590c6cffe/images/ubuntu/scripts/build/configure-apt-sources.sh#L8-L16)
and [APT configuration](https://github.com/actions/runner-images/blob/7e7dc1bcc0ef464e5e315a2b4c33609590c6cffe/images/ubuntu/scripts/build/configure-apt.sh#L17-L40).

## Decision

The shell-completion and Web jobs use the shared
`.github/scripts/use-ubuntu-archives.sh` preparation command before their APT
consumers. It verifies that the Ubuntu Deb822 sources reference the supplied
local mirror list, verifies the official HTTPS archive and security candidates,
then removes the Azure candidate from that list. The existing official entries,
their priorities and other list content remain intact. An unexpected source
layout, missing mirror file or missing official candidate fails the job visibly.
The signed source stanzas, suites, components, keyrings and package indices
remain unchanged.

APT reads the list during the next acquisition process, so changing the list
does not require an additional metadata update. Its
[mirror transport](https://github.com/Debian/apt/blob/db797312548f6e7d6d1d1faa9f1e48c1e521d290/methods/mirror.cc#L356-L390)
loads that process's list on first use; the existing Playwright dependency
installation retains its own normal update. A local isolated APT fixture also
verified a download from a replacement mirror without a second update.

All pinned shell/browser identities, package selection, native and container
scenarios, zero browser retries, coverage thresholds, preparation deadlines,
performance limits and cleanup checks remain required. Local developer setup
and production deployments retain their existing host configuration. The
[README CI section](../../../../README.md#ci-selection) owns the workflow's
validation scope.

## Alternatives

**Rerun unchanged jobs.** A first retry followed confirmed external provisioning
failure. The next Web execution hit the same mirror path, so further unchanged
retries would seek a lucky transfer without removing the observed cause.

**Increase deadlines or add retries.** The runner already configures a retry and
inactivity timeouts. A continuing low-rate transfer can still occupy the full
preparation window. Longer waits change the acceptance budget without changing
the selected mirror.

**Rewrite Ubuntu source stanzas.** The runner already exposes its mirror list as
the selection point. Replacing source stanzas would also take ownership of
suites, components and signing configuration that this repair does not need.

**Preinstall dependencies in a new image or add a package cache.** These can be
added later with their own freshness, image and invalidation rules. They require
new provisioning ownership and do not help explain this dependency transfer.
Keeping the existing APT and Playwright entry points leaves that work additive.

## Consequences

Hosted acceptance obtains Ubuntu packages through the official HTTPS services
and no longer selects the Azure mirror. Network or package failures still fail
the existing gates. The two jobs share one mirror-selection implementation,
and a runner source-layout change becomes an explicit maintenance failure.
This repair adds no product behavior, package cache or alternative browser
execution path.
