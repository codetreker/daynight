# Agent Note: Remove the Herdr daemon and launch mapping

Status: implemented

## Problem

Worker execution no longer consumes the Herdr backend, but its daemon, RPC,
launch mapping and lifecycle database retain a large independent runtime and
packaged SQL. Their existence does not establish that old user-owned executions
have stopped or authorize the Worker to manage them.

## Decision

Remove the unused daemon, session connection, native launch mapping, lifecycle
store and their dedicated tests and SQL resources. Native and Bot process
ownership mechanisms remain independent. Native argument validation remains
while its existing consumers still require it. The Worker does not open or
migrate old Herdr lifecycle databases.

This supersedes the active execution portions of the [frozen launch decision](../architecture/2026-11-12-herdr-frozen-tool-launch.md)
and [local launch mapping](../bug-fix/2026-11-16-herdr-local-native-launch-mapping.md).
Their original evidence and alternatives remain historical.

## Alternatives

**Retain the old runtime for existing claims.** That would continue managing
resources explicitly left to users and require the obsolete launch and storage
contracts to remain operational.

**Remove shared native process proofs with the mapping.** Controller and Bot
still need those proofs to establish process ownership and stopping.

## Consequences

Old Herdr resources are not migrated, stopped or cleaned up. Uploaded historical
recordings retain their separate read path. Native argument validation remains
until its final consumers are removed.
