# Agent Note: Repair Worker Integration Before Native Launch

Status: implemented

## Problem

A worker can have an installed native CLI and valid provider credentials while
its official Herdr integration is absent or outdated. Refusing every such native
launch requires manual repair of integration assets that Herdr already owns.
The official installer's text edits can also damage valid native configuration;
automating those writes exposes later invocations to errors outside the worker.

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

Codex installation first requires a live private daemon child started by this
worker, binding the inspected native environment to the installer process. The
API does not expose an adopted daemon's original environment, so automatic Codex
repair refuses that case before writes and directs a normal worker restart.
An already-current integration does not need this ownership check. Installation
then checks the daemon's version and requires the audited Herdr 0.9.5 installer. Its [TOML rewriter](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/integration/config_edit.rs#L801-L853)
recognizes literal table and key lines, so valid inline or quoted feature tables
can become duplicate tables and apparent headers inside multiline strings can
change string contents. Before the installation RPC, a bounded read obtains the
original `config.toml`; only an absent file means empty configuration. A pure
projection follows that installer, and a TOML parser compares complete original
and projected values. Only enabling `features.hooks` and removing the deprecated
integration-owned `features.codex_hooks` key are permitted. Parsing errors and
other semantic changes refuse installation before any official asset or config
write. Integer comparison retains full precision. Date/time values and parser
constructs without exact semantic representation are refused rather than letting
precision loss conceal a changed value. Diagnostics omit private source text. The worker does not normalize or
write provider configuration itself. Unknown installer versions refuse automatic
Codex repair until their behavior is verified. Already-current integrations and
Copilot retain their existing paths.

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

**Validate only after installation.** The installer can return success after
creating duplicate TOML keys or changing a multiline string. A later native
failure cannot undo the configuration damage already visible to other callers.

**Rewrite native configuration in the worker.** A second configuration writer
would own formatting, comments and provider-specific mutation rules. A read-only
prediction keeps the official installer responsible for actual changes and
refuses layouts that its verified behavior cannot preserve.

## Consequences

Runtime starts can repair the selected official integration while avoiding writes
when it is current. The official installer may affect later native invocations
using that provider home. Verification can still fail after installation, and
cancellation or a lost response does not imply rollback of an installation that
already reached the daemon. A failed launch retains a visible error.

The guard adds a TOML parser and a version-bound model of the official edit.
Safe canonical configurations keep automatic installation; unsupported layouts,
unverified installer versions and an adopted daemon without environment evidence
produce actionable failures before writes.
Semantic comparison preserves values, not comments; the official installer can
remove a hook-setting comment and still pass. The model must be checked against
upstream before accepting another installer version.

Integration configuration and asset writes remain owned by Herdr's official
installer. The guard checks TOML edits, while the official installer continues to
own JSON hook merging. Readback and effective-hook verification observe the
resulting state; they do not reserve provider configuration against later edits. Provider
credentials, unsupported native capabilities, actual hook execution and complete
native task qualification retain their separate requirements.
