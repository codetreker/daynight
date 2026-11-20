# Agent Note: Steps and Thread Scope Admission

Status: implemented

## Problem

Credentials need separate access to task Steps and discussion without bypassing
Project roles, Task versions or execution claim ownership. Existing write
responses can disclose previously stored content, and a discussion append must
respect a concurrent change to its OAuth grant.

## Decision

Scoped Steps operations check read or write permissions within the existing
resource scope. Existing write responses include stored Steps, so their admission
requires both read and write. Thread reads require `thread:read`; posting requires
`thread:post`. The original REST response also requires read access because it
includes author information. A requested minimal REST receipt and the MCP receipt
for a post-only credential contain only the committed message identity. Thread
writes check the current credential policy in the original transaction, retaining
the grant-before-access locking order and claim attribution checks. The existing
production assembly remains unchanged until scoped authentication is enabled.

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
