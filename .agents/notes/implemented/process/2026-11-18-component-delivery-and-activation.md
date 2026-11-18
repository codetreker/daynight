# Agent Note: Separate PR delivery from runtime activation

Status: implemented

## Problem

An invariant may require several runtime effects to change together. Treating
that invariant as a requirement to merge all supporting implementation in one
PR increases the review burden and obscures which changes actually need to
switch together. Release and deployment records also cannot establish which
versions installed clients, Workers or open Web tabs are running.

## Decision

The [development guide](../../../../docs/development.md#component-delivery-and-activation)
owns the decision. Judge PR boundaries using the concrete build, startup and
runtime behavior after each merge. Allow complete, independently verifiable
supporting capabilities to merge before activation when that intermediate
revision is safe. Coordinate only the effects that need to switch together to
preserve the actual invariant, including any startup migrations that would
otherwise take effect before the switch.

Treat client adoption as separate from publication and service deployment.
Verify the version combinations required by the applicable support policy.
The [cancellation](../feature/2026-11-06-task-cancellation-terminal.md) and
[proposed state](../feature/2026-11-10-proposed-task-state.md) decisions retain
their protocol reader requirements. The [property row migration](../../archived/architecture/2026-10-30-task-property-rows.md)
records the upgrade and database recovery constraints of that transition.

## Alternatives

**Group all implementation behind the final cutover PR.** That can preserve the
cutover invariant, but carries extra review load when supporting work can
merge safely first. Keeping inseparable changes together is still appropriate.

**Remove all coordination wording.** That would obscure real transaction,
startup and protocol constraints and could suggest unsupported version
combinations work without verification.

## Consequences

PR size follows meaningful review boundaries and observable intermediate
states. Same-revision product E2E retains its purpose and does not stand in for
mixed-version verification. The policy does not alter runtime behavior or
establish a new version support promise.
