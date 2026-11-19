# Agent Note: Independent Goal Dependency REST Resource

Status: implemented

## Problem

Clients need to read and edit Goal acceptance relationships without changing the existing Task DTO or exposing inaccessible endpoints. Edits depend on precise revisions and opaque edge references, and HTTP and other adapters need identical union and field-presence rules.

## Decision

A separate authenticated GET/PATCH resource exposes the [authorized relationship service](../architecture/2026-11-19-goal-relation-service.md). A pure shared protocol package owns strict JSON admission and response mapping, including exact positive int64 decimal strings, edit/replace unions, hidden targets and editor-only fields. A narrow route service interface keeps relationship operations separate from ordinary Task handlers. The [REST specification](../../../../docs/spec/goal-dependencies.md) owns the wire contract.

## Alternatives

**Add relationships to ordinary Task DTOs and mutation inputs.** This would couple independent revisions and permission-redacted edges to existing Task versioning, synchronization and old client parsers.

**Parse the relationship union independently in each transport.** Separate parsers would permit differences in null, unknown fields, retained-edge references and exact revisions. Shared pure parsing gives subsequent adapters the same admission rules.

## Consequences

Clients perform an independent relationship read and preserve its revision for one edit attempt. Existing Task readers retain their original fields. Public relationship writes require the lifecycle and Project-cleanup protections already present in the service. Relationship responses use no-store; conflicts and unknown outcomes require observation and a new caller decision. Protocol tests own strict admission and redaction, while the real API normal flow verifies registration and legacy detail/sync independence.
