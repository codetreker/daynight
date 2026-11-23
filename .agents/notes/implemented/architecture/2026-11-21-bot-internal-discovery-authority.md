# Agent Note: Bot internal discovery authority

Status: implemented

## Problem

Bot creation may need a live native model catalog to validate an explicit model,
reasoning effort, or stored preference. Reusing the public Worker inspection
requester adds a separate permission to a credential that is already admitted to
create and read the resulting Bot. The public requester also retains fixed API
OAuth restrictions that cannot authenticate an MCP grant's internal discovery.

## Decision

Bot creation and public Defaults use distinct requester capabilities on the same
Worker read-only broker. Creation captures its complete Bot operation set from
the original request, including an explicit attention projection, before issuing
model requests. The internal requester copies that set, obtains current authority
for the original credential through the shared credential source, and preserves
owner-scoped Worker lookup and liveness checks. PAT and MCP policies are checked
without conferring public inspection permission.

Each pending broker request owns its requester callback. Dispatch, producer-driven
result delivery, and final return invoke that exact callback with the original
principal. The producer's context does not determine the Bot projection, and a
requester refusal does not disconnect the shared producer. Producer authorization,
connection fences, response validation, cancellation, and channel capacity remain
owned by the broker. Public Defaults and direct Worker inspection retain their
inspection requirements. Bot creation still rechecks its full admission in the
original write transaction before persisting the resolved configuration.

The [credential scope design](../../../../docs/design/credential-scope-internal.md)
owns the operation mapping. The [Worker admission decision](2026-11-20-worker-scope-admission.md)
retains the independent producer and public requester rationale.

## Alternatives

**Require Worker inspection for Bot creation.** This prevents an otherwise valid
Bot definition credential from selecting native settings and contradicts the
separate operation contract.

**Use an unscoped requester or skip a delivery check.** Either can return a model
catalog after permission removal or credential revocation.

**Use another broker or a context marker.** Another broker has no live producer
connections. A marker from the request context is unavailable when the producer
delivers a response; a server-side pending callback preserves the exact authority
through that boundary.

## Consequences

Services select internal operation requirements explicitly; wire requests cannot
choose their authorization callback. The shared broker can carry different trusted
requester capabilities while keeping one producer channel. New internal discovery
consumers must bind their complete operation set before dispatch and preserve all
existing resource and delivery checks.
