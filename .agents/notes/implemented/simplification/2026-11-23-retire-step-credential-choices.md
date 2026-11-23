# Agent Note: Retire Steps Credential Choices

Status: implemented

## Problem

Steps REST routes and MCP tools no longer exist, so offering their permissions
in new credentials misrepresents available capabilities. Existing credentials
and approved authorization codes still contain those stable scope IDs.

## Decision

Production PAT and MCP catalog snapshots exclude `step:read` and `step:write`
in addition to deployment-specific exclusions. Their revisions reflect the
remaining choices and defaults. The scope registry retains both IDs for saved
policies, approved codes and edits. Existing unavailable IDs may be retained or
removed from a credential, but cannot be newly added.

This narrows the active choices of the [credential scope contract](../architecture/2026-11-20-credential-scope-contract.md)
after [REST Steps retirement](2026-11-23-retire-rest-task-steps.md).

## Alternatives

**Remove the IDs from the registry.** Normalization would reject saved policies
and approved codes, breaking unrelated permissions in mixed credentials.

**Rewrite saved credentials.** A migration would change existing grants and
approval contracts without restoring any public Steps operation.

## Consequences

Mixed credentials retain their other permissions and identity. Step-only policies
gain no Task permissions. Pending approvals must use the current catalog revision;
already approved codes retain their original selection. No credential migration
or compatibility endpoint is needed.
