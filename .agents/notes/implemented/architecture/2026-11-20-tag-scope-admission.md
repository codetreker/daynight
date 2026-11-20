# Agent Note: Tag Scope Admission

Status: implemented

## Problem

Tag catalog access, editing and deletion need independent credential permissions.
Shared REST and MCP operations must preserve project visibility, versions and
transactional association updates. Full mutation responses also expose data that
was not supplied by the caller.

## Decision

The scoped Tag service accepts explicit credential authorization and shares the
existing catalog operations with the original service. Core owns the Tag operation
requirements and profile validation. Each snapshot or project write checks existing
resource access before scope admission, and admission precedes catalog access or
mutation. REST and MCP have opt-in registration paths that reuse their parsers and
response mapping. Production assembly retains its existing entry points.

Reads require `tag:read`. Full create and update replies require both `tag:write`
and `tag:read` before writing. Deletion requires only `tag:delete`, since its receipt
contains only the committed target identity and deletion fact. Association cleanup
and touching affected tasks remain implicit effects of catalog deletion; ordinary
task-tag association changes retain their separate task permission.

## Alternatives

**Checks only in transport handlers.** They would leave shared service calls
without the same admission and separate permission checks from project visibility
and transaction boundaries.

**A write-only full response.** Update replies contain prior fields and usage.
Requiring read permission before mutation preserves the existing response without
leaking those facts or inventing a new receipt protocol for Tag operations.

**Inferring unrestricted access from an absent policy.** Missing scoped credential
facts could then authorize work. The scoped API requires an explicit validated
profile; the original product assembly remains a separate entry point.

## Consequences

Denied operations cannot read catalog content, change tags, touch associated tasks,
clear associations or rotate the catalog epoch. Existing role, version and
transaction completion rules still apply. REST retains the strict forbidden error
envelope with a scope status header; MCP retains its business error and write
outcome envelopes. Credential persistence, fresh authentication snapshots and
production activation remain outside this internal admission mechanism.

The [internal contract](../../../../docs/design/credential-scope-internal.md) owns
the operation mapping and assembly boundary; the
[credential scope decision](2026-11-20-credential-scope-contract.md) owns the
shared policy vocabulary.
