# Agent Note: Authentication Identity Consumer

Status: implemented

## Problem

Complete Authentication required the concrete Identity service even when an
assembly or HTTP test needed controlled identity results. That prevented the
production adapter and its request authentication binding from being exercised
with direct operation outcomes without running unrelated identity workflows.

## Decision

Authentication consumes a private interface containing its 17 direct Identity
operations. The production Identity service satisfies it structurally. Its
constructor validates the supplied object's callback against the full settings,
retains that object for routes and binds its Authenticate method to the real
request middleware. Strict consumer tests supply fixed principals and errors
while executing the production constructor and HTTP credential mechanisms.

This partially supersedes the concrete Identity description in the
[Go test dependency boundaries decision](2026-11-08-go-test-dependency-boundaries.md).
The separate request middleware remains the appropriate dependency for ordinary
Task handlers, which do not consume account operations.

## Alternatives

**Keep concrete Identity and prepare real credentials.** This couples adapter
and assembly proofs to login, persistence and identity business decisions, and
cannot supply controlled results at the direct consumer boundary.

**Replace Require with a principal-only handler.** This bypasses actual Bearer,
cookie and Origin processing and cannot verify constructor method binding.

## Consequences

The complete adapter can receive controlled operation results without changing
its HTTP mechanisms or exposing a test setter. Its existing login, PAT, device
and upstream test matrices remain in place; this port proof does not claim that
those suites have been isolated or establish real credential validation.
