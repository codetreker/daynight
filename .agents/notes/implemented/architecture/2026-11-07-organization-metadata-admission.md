# Agent Note: Organization Metadata Admission

Status: implemented

## Problem

Large organization names and repository addresses can consume substantial
storage and processing even when the number of resources returned is bounded.
Project creation and repository registration have multiple entry points, so a
limit at one protocol adapter would leave other write paths unbounded.

## Decision

The Team and Project domain validators apply the shared candidate policy to
ordinary Team names, Project names and repository addresses. Names must satisfy
both the code point and UTF-8 byte limits; repository addresses are bounded in
bytes before parsing and matching. Existing validity, identity, authorization,
version and repository reuse rules remain in force. A capacity rejection is an
`invalid_input` and does not write organization data.

The [input policy decision](2026-11-07-api-input-policy.md) owns the shared
measurement and policy catalog. The [MCP Project decision](../feature/2026-11-06-mcp-project-management.md)
owns repository reuse and its lack of a global uniqueness constraint.

## Alternatives

**Limit only HTTP and MCP inputs.** Internal callers could bypass the limits,
and independent adapters could disagree on measurements and acceptance.

**Limit only the number of Unicode code points.** Multi-byte text could still
consume more storage and output bytes than a byte budget allows.

## Consequences

All creation and rename paths share the domain rules without truncating input.
The bounds apply to new candidates; they do not scan or rewrite stored data.
An exact-name Team rename remains a no-op even for a legacy oversized name.
Repository parsing and matching retain their existing formats and semantics,
including unique visible matches that need no creation confirmation.
