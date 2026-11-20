# Agent Note: Worker execution scope admission

Status: implemented

## Problem

Permission to enable automatic execution does not imply permission to claim,
finish, stop or recover an execution. Server requests need independent
permissions while retaining their original execution identity and without
exposing Task content in a write-only response.

## Decision

The scoped Task service classifies claim, execution report, release and withdrawal
separately, retaining the existing role, version and claim checks. Claim-bound
completion uses the existing separate classification. Scoped REST claim routes
carry the authenticated policy and full-response or minimal-receipt selection.

Task Session recovery grants check the current retry permission alongside
producer authority while retaining the original claim and generation checks. The
[internal design](../../../../docs/design/credential-scope-internal.md#worker-任务执行准入)
owns the mapping and activation boundary. Existing production assembly remains
unchanged until scoped activation.

## Alternatives

**Reuse Task read or Agent authorization.** Neither describes the ability to
retry, stop or recover an execution, and doing so would conflate independent
permissions with visibility or permission to enable automatic execution.

## Consequences

Removing claim permission prevents new claims without implicitly denying release
or recovery. Server requests use the appropriate current authorization; CLI
local operations retain their existing semantics. Scoped activation must wire
the corresponding service routes and authorization sources together.
