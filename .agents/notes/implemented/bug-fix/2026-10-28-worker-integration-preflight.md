# Agent Note: Repair Worker Integration Before Native Launch

Status: implemented

## Problem

A worker can have an installed native CLI and valid provider credentials while
its official Herdr integration is absent or outdated. Refusing every such native
launch requires manual repair of integration assets that Herdr already owns.

## Decision

Runtime preflight reads the selected provider through the private daemon's
`integration.list`. Exactly one valid target record is required. `current`
produces no installation write; only `not_installed` and `outdated` invoke
`integration.install` with `{target: agent}`. A successful response is followed
by a new list request requiring `current`. Missing or duplicate target records,
malformed metadata and unknown states fail without a repair attempt.

The official daemon [installation handler](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/api/integrations.rs#L32-L50)
uses Herdr's installer for both absent and outdated assets. Its [parameter
schema](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/schema/integrations.rs#L20-L23)
accepts the target alone. The worker delegates integration configuration and
hook-asset writes in the daemon's provider home to that installer. It does not
copy the shell's status or configuration into the private daemon.

Each launch makes its own list, conditional installation and readback requests
to the private daemon. Its [event loop](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/server/headless.rs#L2871-L2881)
processes official handlers synchronously, one request at a time. This orders
individual daemon requests, not an entire preflight sequence; each preflight
uses its caller's cancellation and deadline.

Before `agent.start`, each launch still verifies native prerequisites and the
effective hook feature and SessionStart command in its actual task directory
with its applicable native settings. Installation success and static checks do
not prove hook execution, provider authentication or business-input readiness.
Runtime failures and cancellation remain visible and prevent that launch.
Unknown installation outcomes are not replayed automatically; a later attempt
starts by reading actual state. Existing live-agent reconnection keeps its own
path without installation.

Setup shares only read-only prerequisite checks and offline integration status.
It neither launches the private daemon nor installs integration. This decision
partially supersedes the explicit-installation refusal in the [original Herdr
adapter decision](../architecture/2026-10-26-worker-herdr-adapter.md). That refusal
kept prerequisite inspection from changing later human native invocations; the
setup boundary preserves that property while runtime owns the integration repair
needed for unattended starts. The [full-access
policy](../architecture/2026-10-27-worker-full-access.md) continues to own invocation
permissions and trust rather than installation.

## Alternatives

**Require manual integration installation before every runtime start.** This
preserves the original refusal to change native configuration but leaves an
unattended worker unable to repair missing or outdated assets through Herdr's
existing official capability.

**Perform installation in shared prerequisite checks.** Setup reuses those
checks for bounded read-only diagnostics. Putting writes there would make
inspection alter provider configuration and erase setup's ownership boundary.

## Consequences

Runtime starts can repair the selected official integration while avoiding writes
when it is current. The official installer may affect later native invocations
using that provider home. Verification can still fail after installation, and
cancellation or a lost response does not imply rollback of an installation that
already reached the daemon. A failed launch retains a visible error.

Integration configuration and asset writes remain owned by Herdr's official
installer. Readback and effective-hook verification observe the resulting state;
they do not reserve provider configuration against later edits. Provider
credentials, unsupported native capabilities, actual hook execution and complete
native task qualification retain their separate requirements.
