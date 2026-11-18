# Agent Note: Persist Worker Web mode adoption

Status: implemented

## Problem

The configuration page consumes an independent mode application result. A Worker
that selects Web from synchronized desired configuration without reporting that
result leaves the page waiting indefinitely. Neither the saved target nor an
online heartbeat proves that the Worker adopted it. Existing checkpoints also
need to gain the missing obligation without losing unrelated application facts.

## Decision

Schema 10 originally restored the `agentControlMode` ledger item for applicable
Web targets. The configuration manager applied it through the scalar commit
owner, recorded its actual source, and published execution eligibility only after
persistence. Adoption needed no Herdr tool, selected Project or Task execution.
The report projection, capability filter and receipt fences carried the result
without a new wire format or server-generated success.

Schemas 1–9 retain their frozen validation. In particular, schema 9 rejects mode
items. The original migration created only a pending mode obligation, without an
actual value or source. Other records and responsibilities retain their existing
migration rules. The [two-tool protocol decision](2026-11-17-worker-two-tool-protocol.md)
replaces public mode adoption: ordinary current target transitions do not create
mode items and Workers do not publish mode observations. Schema 10 remains the current storage format,
and the frozen reader still validates historical mode facts. Unsupported or
unknown targets remain raw authority and close admission.

The original implementation required a new adoption confirmation for known
target changes and authority resets. An equal higher revision retained the
application anchor and actual provenance; the report envelope identified the
current desired revision. The website checked that envelope before accepting a
mode result, while allowing an older item revision for an unchanged value.

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

The original mode field converged from real Worker evidence without reintroducing
Herdr execution. Migration itself proved no adoption, and failed or cancelled
persistence could not publish a successful result. The current two-tool protocol
removes the public mode field rather than claiming adoption; actual tool and
configuration observations still distinguish missing or unapplied facts from success.
