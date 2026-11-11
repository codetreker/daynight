# Agent Note: Server Layered Configuration and Root

Status: implemented

## Problem

Environment-only startup makes a deployment's static settings difficult to review
and reuse. Relative storage paths depend on the process working directory, so
starting the same deployment from another directory can select different data.
Secrets and malformed input must not appear in startup diagnostics.

## Decision

The command selects an absolute root before loading configuration. Each owning
module supplies defaults, a partial YAML patch, explicit environment overrides,
validation, and path resolution when needed. The aggregate applies base YAML,
local YAML, and explicitly set environment values in order. It validates each
file's syntax, duplicates, and known types before merging and validates final
semantics before opening resources. The backup verifier applies and validates
only database and storage settings after the same file format checks.

Relative file paths use the selected root, without cleaning storage traversal.
Diagnostics carry safe source and field metadata without configuration values.
The [module ownership decision](2026-11-11-server-module-configuration.md)
retains the rationale for module-owned configuration.

## Alternatives

**Keep environment-only configuration.** This avoids file parsing but leaves
static deployment settings scattered across startup environments and does not
establish a common root for relative paths.

**Define a second flattened file schema.** Duplicating module fields and rules in
the aggregate would require two owners to remain synchronized.

## Consequences

Deployments can use private overrides without changing the base file, and
explicit empty or zero values are distinguishable from absent fields. The YAML
loader must reject invalid earlier layers even when later layers override them.
Existing relative storage paths change their base and operators must verify their
actual data directory when migrating. Both Compose deployments mount a public base configuration directory read-only;
dev-ci copies its base into a run-owned directory so unrelated local overrides
cannot redirect its database or storage. Dynamic credentials remain in their
existing environment sources. Native test runners generate private configuration
under their isolated roots. The [file logging decision](../feature/2026-11-11-server-file-logging.md)
owns output and process-lifetime rules.
