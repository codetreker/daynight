# Agent Note: Remove the Top-Level Configuration Setup Command

Status: implemented

## Problem

A normal CLI user already has a production service default and an explicit
browser-authorized login. A separate top-level initialization command suggests
that those steps still require configuring a server or transferring a secret.
Its remaining review repository registration overlaps an existing command and
first-use guidance. Keeping the generic entry also leaves review interaction
owned by shared configuration code rather than the capability that needs it.

## Decision

The root command tree has no `setup` operation or compatibility alias. Help,
parsing and Bash/zsh completion use that same tree. `daynight login` continues to
use `https://daynight.cc` when service configuration is absent.

Review repository preparation uses `daynight review add-repo <remote> [--path
<path>]`. Interactive `review run/list/ls` retain their missing-file or
missing-repositories guidance. `commands/review/configuration-guide.ts` owns that
interaction and uses the existing repository updater and shared configuration
writer. It collects input before the locked reread, detects selected review-field
changes, merges unrelated completed changes and saves atomically. Noninteractive
missing configuration points to `review add-repo`.

Test services and unattended credentials use the existing YAML `serverUrl` and
`serverToken` fields, prepared by their test, deployment or secret-provisioning
owner. There is no replacement generic configuration command. A provisioner must
pair an origin with its intended credential, remove or replace the old token
when changing services, preserve unrelated settings and protect the file. External
writers do not participate in CLI locks or execute automatic credential cleanup.
Readers retain strict origin, token and transport validation; login/logout retain
locked observation checks and atomic persistence.

`daynight completion setup` independently installs shell startup configuration
and remains available. The [completion decision](../feature/2026-10-21-completion-setup.md)
owns that operation.

This supersedes the root setup entry and noninteractive service-write options in
the [guided configuration decision](../feature/2026-10-21-guided-configuration-setup.md),
[credential decision](../architecture/2026-10-22-cli-server-credentials.md) and
[device-login decision](../architecture/2026-10-25-cli-device-login.md).
Their historical rationale, safe persistence, capability projections and
credential transport rules remain relevant. The [client requirements](../../../../docs/spec/daynight.md#c6-按需配置引导)
and [client design](../../../../docs/design/daynight.md#按需配置引导) own current behavior
and module composition.

## Alternatives

**Keep setup as a convenience wrapper.** It duplicates review registration and
keeps a generic initialization step visible after routine service setup has
become unnecessary. It would also preserve a shared module whose only interactive
consumer is review.

**Add another generic configuration command.** It retains the same extra surface
under a different name. Existing review operations and the established YAML
fields cover the remaining consumers without a new command contract.

## Consequences

Normal use has one explicit login step. Review retains both advance registration
and interactive first-use guidance, with its interaction under its own module.
Removing the exclusive service-write paths also removes their parser, input and
command acceptance obligations while preserving shared configuration machinery
that still has callers.

Scripts using the removed service options must provision an explicit configuration
file. This makes their origin, credential and file-permission ownership visible;
it does not promise CLI coordination for arbitrary external editors. Existing
configuration files remain readable without a format migration. A future managed
provisioning interface would require its own concrete consumer and transaction
contract; it is not replaced by a hidden setup alias.
