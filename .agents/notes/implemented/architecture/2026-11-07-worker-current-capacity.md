# Agent Note: Worker Current Resource Capacity

Status: implemented

## Problem

Worker reports and configuration can grow independently of the request body.
A report with no inventory can retain an older task snapshot, and a stored
configuration observation adds server metadata. Measuring only the incoming
body cannot bound the resulting resource. Configuration application also needs
unconfirmed failures and removals to survive long enough for recovery.

## Decision

Worker field, collection, and numeric limits apply to reports, configuration,
and their producers. The server measures the final merged Worker and stored
configuration observation before committing their transaction. The protocol
and exact limits belong to the [snapshot](../../../../docs/spec/daynight-worker-snapshots.md)
and [configuration](../../../../docs/spec/daynight-worker-configuration.md)
 specifications.

The Worker bounds growth of its current application observations and uses the
existing receipt to compact confirmed results that are no longer needed. It
retains unfinished removals and unconfirmed failures and does not truncate a
complete inventory. Startup retains registration progress across capacity retries
within the current run and re-observes retained projects after restart. The
[configuration decision](../../archived/architecture/2026-11-04-worker-cloud-configuration.md)
records the original separation between target and application observations.

## Alternatives

**Measure only the incoming request.** A small unavailable inventory can retain
a larger previous snapshot; server-added observation metadata also makes the
stored object larger than the submitted value. Neither is bounded by that check.

**Discard old observations at capacity.** Age alone cannot distinguish a
confirmed result from an unfinished removal or an unknown receipt. Discarding
it can lose the evidence needed to recover.

## Consequences

Capacity failures roll back the report or configuration mutation, including
liveness and snapshot writes. Field maxima and the total encoding budget apply
together, so individual maxima are not guaranteed to fit simultaneously. The
current collection can converge after acknowledgments while unresolved work
continues to consume capacity; capacity does not limit historical Worker rows.
