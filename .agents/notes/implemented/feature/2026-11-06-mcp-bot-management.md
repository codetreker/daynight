# Agent Note: MCP Bot Management

Status: implemented

## Problem

Remote MCP clients need to create and inspect Bot definitions and request their
deletion without confusing persistence with readiness or losing the identity and
cleanup state of a write whose response is lost.

## Decision

The four Bot tools use the shared authenticated entry, existing default
resolution and the same deletion coordinator and Session barrier as REST.
Creation uses the request ID as the Bot ID; deletion uses it as the deletion ID
and requires an exact version. When omitted, the ID is generated before the
operation and included in failure references. Reads expose the existing Bot
representation, including the minimal deletion responsibility and both cleanup
states. List pages retain complete items and a cursor for the last returned item.

## Alternatives

**Delete only the definition.** This would bypass Session admission revocation
and the durable Worker and server cleanup responsibilities.

**Resolve defaults in the adapter.** A separate resolution would duplicate the
transactional host selection and could diverge from REST creation.

## Consequences

Persisting a definition does not establish startup readiness. A lost response
does not establish the outcome; clients retain the original operation identity
and inspect current state. Cleanup is complete only when both phases report it.
