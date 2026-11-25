# Agent Note: Default-enabled usage and Codex version admission

Status: implemented

## Problem

A service with no usage configuration refuses otherwise authorized reporting.
Codex response collection also rejects native versions outside a fixed binary
list even when the response fields satisfy the existing measurement contract.
The profile name combines a historical validation version with a durable data
contract, making that version look like a permanent executable requirement.

## Decision

The [usage contract](../../../../docs/spec/task-token-usage.md) enables writes
by default in server environment assembly. Explicit
`DAYNIGHT_USAGE_WRITE_ENABLED=false` still disables writes without removing the
ledger, migrations or reads. Configuration accepts only exact true or false;
explicit service `Options.WriteEnabled=false` retains its meaning.

The service automatically qualifies `codex-response-0.169.0-v1` for a real
`providerVersion`. The CLI accepts valid semver from the actual App Server
initialize handshake and records the complete version, including prerelease or
build metadata. New states use this response profile without an exact binary
version allowlist or a per-version deployment entry. Rollout
`session_meta.cli_version` must equal the actual handshake version, and the
original file, native identity, source attribution, field and metric checks
remain mandatory.
Missing or invalid handshake versions cannot borrow a known version.

The profile ID remains `codex-response-0.169.0-v1` because persisted sources and
states use it as a data contract. Old snapshot states remain unsupported;
resume and CLI upgrades do not rewrite their profiles. Copilot, Claude and
other providers still require their exact deployment-qualified combinations.
The [design](../../../../docs/design/task-token-usage.md) distinguishes the
qualified Codex baseline capability from their configured `qualifiedVersions`.

This partially supersedes the
[response usage decision](../feature/2026-11-23-codex-response-token-usage.md)'s
exact 0.169.0 deployment requirement and the
[single-table decision](../architecture/2026-11-18-single-table-token-usage.md)'s
Codex version admission. Their ledger, grants, independent acknowledgements,
source identity and partial-coverage decisions remain in force.

## Alternatives

**Keep the exact Codex binary gate and explicit deployment qualification.**
The original tested 0.169.0 runtime provided bounded evidence for introducing
response accounting. Keeping that admission rule excludes compatible native
responses solely because the binary version changes. The fixed data contract
and actual provenance checks remain the admission criteria instead.

**Keep writes disabled when the environment variable is absent.** This requires
an operator action before authorized collectors can report any usage. Default
enablement removes that prerequisite while retaining explicit false as the
operational control.

## Consequences

An unconfigured service accepts authorized usage writes. New Codex states can
report native responses across versions without renaming stored profiles or
configuring each version. Existing source deduplication, grants, immutable
revisions and partial-only coverage continue to bound what is counted.

0.169.0 remains the original tested runtime for the response profile. Removing
its executable gate does not establish real E2E evidence for later versions.
A version can be admitted yet produce no valid measurements when native fields
or provenance differ; those gaps remain explicit and native execution continues.
A change to response semantics requires reassessing the profile contract rather
than treating automatic qualification as proof of unchanged upstream behavior.
Rollouts with metadata from another handshake version remain rejected even when
both versions satisfy semver. Operators needing to stop writes must explicitly
set `DAYNIGHT_USAGE_WRITE_ENABLED=false`.
