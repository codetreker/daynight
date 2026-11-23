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

The Worker bounds each transmitted application observation while retaining
complete local facts separately. The
[fact separation decision](2026-11-12-worker-configuration-fact-separation.md)
replaces the original shared collection used for local retention and reporting.
Matching receipts compact only confirmed records whose resource obligations have
ended; unfinished removals, unknown results and unsent failures remain local.
A task inventory stays complete. Startup retains registration progress within
the current run, registers remaining local stop obligations independently of a
report batch, and re-observes retained projects after restart. The
[configuration decision](../../archived/architecture/2026-11-04-worker-cloud-configuration.md)
records the original separation between target and application observations.
The [platform preference decision](../feature/2026-11-09-worker-platform-task-preference.md)
introduced the 1025 observation bound for its additional global item. Each
current wire batch retains that non-mode bound; negotiated mode evidence uses the
additional 1026th slot without reducing the local lifetime of unresolved facts.

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
latest wire batch can converge after matching acknowledgments while unresolved
local work retains its original resource responsibility. Local fact retention
uses the required memory and disk; those facts are not deleted to fit a report.
These write limits do not limit historical Worker rows.
