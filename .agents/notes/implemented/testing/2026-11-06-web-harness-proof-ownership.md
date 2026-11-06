# Agent Note: Web Harness Proof Ownership

Status: implemented

## Problem

Separate acceptance harness fixtures can exercise the same native process-group
lifecycle while obscuring which assertions prove recovery behavior. Assertions
about arithmetic on already checked fixture lengths or a fixture helper's own
return path do not detect defects in inventory aggregation or coverage analysis.

## Decision

The native platform identity lifecycle checks the public group-stopped result
both while its detached child is active and after it exits, as well as the
recovery refusal and success paths. The identity tests retain start-time and
executable mismatch protection, invalid identities, process disappearance and
probe failures. Platform-specific boundary tests remain independent.

Inventory tests retain the functional and stress counts and exercise actual
report aggregation. Coverage tests retain nested source creation, statement
totals and the complete classified file map. They do not assert derived integer
arithmetic or the fixture helper's returned destination.

## Alternatives

**Keep both native lifecycles.** The extra child repeats the same recovery path;
the platform lifecycle can carry the direct return-value assertions while also
checking native identity, platform and group boundaries.

**Remove the weaker lifecycle without migrating assertions.** The remaining
recovery checks would indirectly use the group result but would not directly
verify its public false and true values for a real group.

## Consequences

One detached child and redundant fixture-only assertions are removed without
changing the product or the acceptance and coverage gates. This reduces
maintenance and native process work, but does not by itself establish a CI
speedup. The pristine Dagre oracle, callback phase watchdog and native fault
matrix retain their independent proofs.
