# Agent Note: Ship a Complete CLI Configuration Example

Status: implemented

## Problem

CLI configuration is shared by service access, review and worker commands, while
usage examples explain each capability separately. Readers need a complete file
to discover the available fields, distinguish defaults from optional overrides,
and understand which paths and identities require their own values. An npm
installation also needs that reference without requiring a source checkout.

## Decision

[`packages/daynight/config.example.yml`](../../../../packages/daynight/config.example.yml)
is the canonical complete example. The npm package includes it at its root
through the manifest's `files` list. The CLI manual owns customization and
installed-file discovery; the repository README links to that entry and example.

The file contains valid server, review and worker configuration with generic
repository placeholders. Optional credentials and model overrides are commented,
and generated `workerId` is explained without supplying a shared identity.
Comments preserve the different path rules and repository override semantics.
Existing configurations are selectively merged so credentials, identity and
unrelated capabilities remain intact. Commands retain their current loading and
configuration-writing behavior.

## Alternatives

**Keep complete configuration only in the manual.** Separate explanatory examples
remain useful beside their commands, but readers must assemble them and identify
omitted fields themselves. A named YAML file also provides a direct artifact for
checking against the parsers and sharing with installed-package users.

**Copy the example into the build output.** The file has no compilation step or
runtime loader. Publishing the source file directly avoids an additional copy
step and an extra generated location whose contents could diverge.

## Consequences

Source checkouts and npm installations expose the same reference bytes. The
example must stay synchronized with configuration fields, defaults and semantics;
actual parser and packed-artifact validation can check those relationships.
Repository and project placeholders require customization before use. The file
provides reference material without making a complete sample configuration a
prerequisite for normal login or other independent commands.
