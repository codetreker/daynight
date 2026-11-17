# Agent Note: Persist Worker Web mode adoption

Status: implemented

## Problem

The configuration page consumes an independent mode application result. A Worker
that selects Web from synchronized desired configuration without reporting that
result leaves the page waiting indefinitely. Neither the saved target nor an
online heartbeat proves that the Worker adopted it. Existing checkpoints also
need to gain the missing obligation without losing unrelated application facts.

## Decision

Schema 10 restores the existing `agentControlMode` ledger item for applicable
Web targets. The configuration manager applies it through the scalar commit
owner, records its actual source, and publishes execution eligibility only after
persistence. Adoption needs no Herdr tool, selected Project or Task execution.
The existing report projection, capability filter and receipt fences carry the
result without a new wire format or server-generated success.

Schemas 1–9 retain their frozen validation. In particular, schema 9 rejects mode
items. Migration creates only a pending mode obligation, without an actual value
or source; an unchanged schema 9 target therefore recovers automatically. Other
records and responsibilities retain their existing migration rules. Schema 10
preserves real mode facts across restart, while the first authoritative read
requires adoption again before granting execution eligibility. Unsupported,
unadopted and unknown targets remain raw authority and close admission.

Known target changes and authority resets require a new adoption confirmation.
An equal higher revision retains the application anchor and actual provenance;
the report envelope identifies the current desired revision. The website checks
that envelope before accepting a mode result, while allowing an older item
revision for an unchanged applied value.

This partially supersedes the omission of mode items in the
[Web checkpoint decision](2026-11-17-worker-web-configuration-checkpoint.md).
That decision correctly rejected synthetic success, but omission also removed
the evidence still required by the website. The
[configuration contract](../../../../docs/spec/daynight-worker-configuration.md)
and [Worker design](../../../../docs/design/daynight-worker.md) own current
behavior and mechanisms.

## Alternatives

**Display the desired mode as applied.** A saved target does not establish
adoption, and this would hide unsupported targets or persistence failures.

**Insert mode items into schema 9.** Deployed schema 9 validation rejects them;
reusing the version would make its storage contract ambiguous.

**Require the user to save the same target again.** Existing installations would
remain indefinitely pending despite successful synchronization. Migration can
create the missing obligation without changing user-owned configuration.

## Consequences

The mode field and overall configuration can converge from real Worker evidence.
The checkpoint format advances without changing the CLI release version or
reintroducing Herdr execution. Migration itself proves no adoption, and failed
or cancelled persistence cannot publish a new successful result. The website
continues to distinguish missing, stale and unapplied observations from success.
