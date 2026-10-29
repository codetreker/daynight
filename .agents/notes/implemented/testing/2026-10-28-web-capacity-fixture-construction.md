# Agent Note: Capacity fixture dependency construction

Status: implemented

## Problem

Production browser capacity acceptance builds its complete graphs through real
authenticated APIs. Creating a dependent task after its upstream layers exist
makes every dependency admission traverse that accumulated ancestry. Dense
merge and external graphs therefore spend substantial setup time before browser
measurements begin. Fixture setup and measured page feedback have different
purposes and costs; reducing input size or weakening measurements would change
what the acceptance result proves.

## Decision

Chain, merge and external fixtures create dependency-free tasks in their existing
source-first batches. Dependencies are attached from sinks toward sources using
versioned public PATCH requests. Merge and external process one whole reverse
topological layer before starting the next, reusing the six-request bound within
a layer. Each prerequisite is still independent when reachability validation
visits it. The chain retains its existing sequential reverse attachment.

Every PATCH-returned Task replaces the earlier value. The merge limit probe
retains the final task version and its missing predecessor. The external sink
is classified with the existing helper only after attachment, using its current
version; the root remains ordinary and its other 107 predecessors remain
external. Shared-root construction retains its direct API writes.

All four inputs, graph formulas, creation batches, logical ID positions and
snapshot-derived overview order remain intact. Complete API readback still
compares ordinary and external dependencies. The five repetitions, independent
node/edge-limit refusal and restoration, geometry, performance budgets, traces,
screenshots and cleanup retain their existing meaning. The [Web README](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns the repeatable acceptance entry and evidence. The archived [CI efficiency
decision](../../archived/testing/2026-10-21-ci-validation-efficiency.md) retains
the original chain-construction rationale and diagnostic boundaries.

## Alternatives

**Create dependencies with each task.** This uses fewer API requests, but each
later merge or external layer repeatedly admits already-connected ancestry.
Shared-root construction keeps this approach because its shallow topology has
a different setup cost.

**Raise request concurrency.** Same-project writes serialize through their
project transaction. More queued requests do not remove ancestry traversal;
the existing six-request bound remains sufficient for each independent layer.

**Attach all reverse-ordered tasks concurrently.** Array order does not establish
completion order. Without a whole-layer barrier, an upstream task can acquire
dependencies before a downstream admission finishes, losing the intended
independence during traversal.

**Bulk seed PostgreSQL or alter service admission.** Direct database seeding
would stop proving public API graph construction. Service reachability changes
would affect product behavior beyond this fixture optimization.

**Reverse shared-root attachment too.** It would add 500 PATCH requests to a
shallow graph. That remains an independent choice if future fixture timing
justifies the added writes; the layered constructor does not require changing
the shared graph's topology or acceptance.

## Consequences

Merge adds 999 PATCH requests and external adds 900, trading request count for
less accumulated ancestry during admission. This does not establish an elapsed
time bound: reachability still queries stored edges, and actual savings belong
to source-bound fixture and capacity receipts. Construction failures propagate;
there is no direct-database fallback or reduced-input success path.

Creation and dependency attachment have separate ordering responsibilities.
Keeping them explicit preserves task versions, logical graph identity and
the actual API order used by visible-topology checks. Browser phase scheduling
and performance isolation are unchanged.
