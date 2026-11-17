# Agent Note: Add the Worker sudo cleanup target

Status: implemented

## Problem

A Worker needs a per-Worker cloud target for optional privileged cleanup, while
saving a configuration must not erase a choice the editor does not recognize.
A stored target is not evidence that a Worker has adopted or applied it. Adding
an unconditional field also makes the original strict clients unable to read the
resource, so delivery and actual client adoption have different rollout effects.

## Decision

The existing Worker configuration resource carries `enableSudoCleanup` as a
boolean, defaulting to false. The service returns it directly without a new
endpoint or capability negotiation. A PUT that omits it retains the locked current
value after the revision check; explicit false is an update. A first bootstrap
that omits it initializes false, and later bootstrap candidates cannot replace an
existing target. The observation protocol accepts a corresponding boolean or
null value with the existing state and revision rules. Missing evidence is not an
applied value.

A migration adds false only to non-null targets that lack the field, advancing
the target revision and update time because the value really changed. Existing
fields, null targets and observations remain intact. Exhausted revisions fail
the migration transaction instead of publishing different content at the same
revision. The [configuration specification](../../../../docs/spec/daynight-worker-configuration.md)
and [design](../../../../docs/design/daynight-worker-configuration.md) own the
current protocol and persistence rules.

This decision builds on the [Worker unknown-configuration preservation](../architecture/2026-11-17-worker-unknown-configuration-preservation.md)
and [Web source preservation](../architecture/2026-11-17-web-worker-configuration-source.md)
decisions. Those clients preserve fields they do not recognize, but their code
being merged or released does not establish that running clients have adopted it.

## Alternatives

**Use a separate cleanup configuration resource.** This would add another
resource and lifecycle for a setting that belongs to the existing per-Worker
target and its observation protocol.

**Negotiate a capability for this field.** The selected compatibility rollout
first updates clients to preserve unknown configuration, then adds the field to
the existing resource. Per-field negotiation would add protocol and rollout
state without replacing the need to preserve unknown values.

**Treat omission as false.** An older editor changing another field could turn
off an existing true target. Preserving the locked value distinguishes omission
from an explicit choice and keeps revision conflict protection.

## Consequences

The server can store and report the target without inventing an application
result. A compatible Worker that does not recognize it continues its known
behavior, while an implementation that recognizes it can report actual status.
The server field alone does not provide sudo execution or a Web control.

Before deploying a service that emits the field, operators must verify that the
Workers in the supported population actually run the compatibility patch and
that Web clients, including already open pages, use the compatible version. The
original strict clients remain incompatible until upgraded. Migration failure at
revision exhaustion requires resolving the stored revision before deployment.
