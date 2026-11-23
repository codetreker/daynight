# Agent Note: Steps and Thread Scope Admission

Status: implemented

## Problem

Credentials need separate access to task Steps and discussion without bypassing
Project roles, Task versions or execution claim ownership. Existing write
responses can disclose previously stored content, and a discussion append must
respect a concurrent change to its OAuth grant.

## Decision

The original scoped Steps operations checked read or write permissions within
the resource scope. Their write responses included stored Steps, so admission
required both read and write. The [application retirement](../simplification/2026-11-23-retire-task-steps-application.md)
removes those operations and checks after both public interfaces retire. Thread reads require `thread:read`; posting requires
`thread:post`. The original REST response also requires read access because it
includes author information. A requested minimal REST receipt and the MCP receipt
for a post-only credential contain only the committed message identity. Thread
writes check the current credential policy in the original transaction, retaining
the grant-before-access locking order and claim attribution checks. Production Thread uses scoped authentication and these registrations. The [REST Steps retirement](../simplification/2026-11-23-retire-rest-task-steps.md) removes public Steps routes and their scope registration; saved scopes keep their existing credential rules, without granting new Task permissions.

## Alternatives

**Transport-only checks.** Shared operations would remain callable without the
same resource and transaction checks, and an OAuth grant edit could race an append.

**Return existing Steps on write-only authority.** The response includes data
outside the caller's input. Requiring read permission before the mutation keeps
the existing response contract without exposing those facts.

## Consequences

Scope checks do not grant Project access or claim ownership. Rejected writes
retain the original transaction outcome semantics, while a post-only caller can
receive a committed receipt without reading history. Scoped entry points and
their operation mapping are described in the [internal contract](../../../../docs/design/credential-scope-internal.md); the
[credential scope decision](2026-11-20-credential-scope-contract.md) owns the
shared policy vocabulary and production activation boundary.
