# Agent Note: Retire MCP Task Steps

Status: implemented

## Problem

Task Steps exposes an independent ordered work resource through MCP discovery,
operation schemas and embedded guidance. Retiring that capability requires those
entry points to agree while ordinary Task, Thread and credential behavior remains
usable. REST clients still require the shared Steps service during the separate
retirement of that interface.

## Decision

MCP registers no `task_step_list`, `task_step_show`, `task_step_add`,
`task_step_update`, `task_step_set_status`, `task_step_move` or `task_step_delete`
tool. Their adapters, schemas, scoped tool inventory and dedicated
`daynight://manuals/steps.md` resource are removed. Calls using those names follow
the existing unknown-tool error path. Surviving manuals retain their exact
published-byte metadata and contain no link to the removed resource.

The shared application Steps service and REST routes remain in place. Credential
scope choices and saved grant policies keep their existing rules; removing a
consumer does not rewrite credentials or imply Task permissions. Mixed grants
retain their other authorizations. Surviving MCP tools retain authentication,
request budgets, permits, deadlines and error contracts.

The [original MCP feature decision](../feature/2026-11-06-mcp-task-steps.md) and
[protocol fixture decision](../testing/2026-11-10-root-mcp-step-operation-boundary.md)
retain the rationale for the retired implementation. Thread fixtures own their
identifiers and assertions independently of the deleted Step fixture.

## Alternatives

**Keep hidden tools or a retirement adapter.** Hidden registration would leave
Steps operations callable, while a dedicated rejection adapter would add a new
error contract for names already handled by unknown-tool behavior.

**Delete the shared Steps application service with MCP.** REST still consumes
that service. Removing it would couple two independently retiring public
interfaces and break the remaining HTTP resource.

## Consequences

Discovery and guidance expose only supported MCP operations. Clients invoking old
names receive an explicit failure, and REST Steps clients retain their current
behavior. The retired tool matrices and MCP-specific capacity stress witness
leave with their implementation; REST, Service, Core and Store tests retain the
shared behavior they own. Real HTTP MCP sessions verify production discovery,
unknown names, surviving manuals and ordinary authorized operations. Those
protocol observations do not establish database persistence or runtime release.
