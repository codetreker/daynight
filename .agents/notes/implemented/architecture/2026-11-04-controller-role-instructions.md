# Agent Note: Shared Controller Role Instructions

Status: implemented

## Problem

A role supplied only as initial user input creates a user turn and cannot express
native role configuration independently of the first request. Shared Controller
startup also needs to carry the same prepared text on native recovery without
invalidating tickets that were written before roles existed.

## Decision

The launch ticket and ProviderOptions accept optional `instructions`. Ticket
parsing validates present values as nonblank, well-formed Unicode within 64 KiB
UTF-8 while preserving their exact text. It retains absent fields, the original
object and schema version; the existing canonical hash covers supplied roles
without changing legacy hashes. Immutable ticket writes bind the role to its
launch identity.

Controller startup conditionally forwards the field through the shared provider
options path for fresh and resumed execution. It never sends the role as input.
Independent no-input tickets retain their empty initial prompt, `not_required`
state and rejection of initial submission. Native permissions, environment and
model defaults remain selected through their existing paths.

The ticket producer owns frozen text across generations. The journal retains
its whole-ticket hash and stopped-native-identity rules, without a new role
store or schema. Provider-specific append, versioned templates and Bot startup
remain separate consumers of this shared field. The
[requirements](../../../../docs/spec/controller-role-instructions.md) and
[design](../../../../docs/design/task-session-protocol.md#角色指令的共享传递)
own the complete contract and mechanism.

## Alternatives

**Default missing roles to an empty field.** This would simplify some callers,
but change serialized legacy tickets and their hashes. Missing remains distinct
from an explicitly invalid value.

**Persist an additional cross-generation role digest in the journal.** This
could reject a producer that changes or drops the role, but would require an
additional persistence and legacy migration contract. The approved ownership
places first preparation and frozen role selection with the Bot producer; the
shared journal cannot recover a role digest from its whole-ticket hash.

## Consequences

Existing Task and Test tickets remain readable. Downstream adapters can consume
roles without manufacturing initial user requests, and producers can preserve
prepared text by carrying it into subsequent tickets. The shared layer does not
enforce role equality across generations: a producer that reconstructs a ticket
must preserve the frozen field. A future ability to edit roles would need an
explicit native and persistence design rather than overwriting a launch ticket.

Contract tests cover byte boundaries, malformed values, immutable writes,
legacy readback, stopped-generation recovery with unknown user operations and
provider option forwarding. These checks do not prove native provider append,
Bot lifecycle integration or real three-provider behavior.
