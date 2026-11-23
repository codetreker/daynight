# Agent Note: Web Ordinary Task Relations

Status: implemented

## Problem

A Task's ordinary parent is distinct from its Goal and dependency edges. Shared
project snapshots may have been written by an older Web bundle that discards the
ordinary-parent field, so an absent field cannot prove that a Task has no parent
or children. Detail navigation and creation need the actual Task IDs without
changing Goal membership or dependency-graph semantics.

## Decision

Web Task requests select the ordinary-parent projection and retain the distinction
between a missing `parentTaskId` and an explicit null. Direct child pages use the
authorized parent filter and current Task and project-history admission. The
ordinary relation controls are available as a shared detail component with separate
parent and child slots; production composition is deferred until the related
lifecycle and cache-withdrawal controls are ready. Links target the ordinary Task's
independent detail URL and use the existing draft-aware browser navigation.

The [server read projection decision](2026-11-23-task-parent-read-projection.md)
owns the protocol and preserves the Goal meaning of `parentId`.

## Alternatives

**Infer children from the project snapshot.** An older bundle can strip unknown
fields from the shared cache, producing a false empty list even when the server
has children.

**Publish the relationship controls immediately.** A partially activated Web
would expose ordinary parent writes before the coordinated lifecycle and deletion
feedback is available. Separate slots and a shared controller let the later
composition retain the established detail layout without changing the relation
read contract.

## Consequences

Child reads and pagination incur separate authorized requests. Missing projection
fields remain unknown, and an unsupported server returns a visible error instead
of a fabricated empty list. Production entry points remain unchanged until the
lifecycle integration is delivered; the component can be exercised independently.
