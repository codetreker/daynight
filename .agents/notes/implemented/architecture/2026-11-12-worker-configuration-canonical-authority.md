# Agent Note: Worker canonical configuration recovery

Status: implemented

## Problem

A Worker checkpoint can retain larger target or observation counters than the
service after a restore, or different target content under the same revision.
Treating counter order as authority leaves the Worker sending observations the
service cannot accept. An initialized service target can also become null while
unfinished stops, claims and unacknowledged failures still belong to the Worker.
Late responses and telemetry collected before realignment can revive the old
baseline or repeat the divergence.

## Decision

An authenticated configuration GET for the running origin, principal and Worker
installs the exact canonical desired and observation baseline, including lower
counters and null. Structurally valid but unsupported known targets remain stored
with admission closed. Matching report receipts install eligible targets and
settle their captured observations; a late lower desired revision cannot replace
a newer received target. Equal-revision documents must be semantically identical.
Known target changes or authority rollback renew the local generation; changes
confined to unknown fields, update time or a forward revision retain generation,
application identities and jobs. Job applicability uses its original record
binding, content and process proof.

The original authority decision accepted equal-revision content changes and lower
receipt targets after service restore and renewed generation on each installation.
The [unknown configuration decision](2026-11-17-worker-unknown-configuration-preservation.md)
replaces those choices to preserve future data, avoid redundant application and
fence late target receipts. Authenticated GET remains the recovery path for an
actual service rollback.

A local capture owns a random report ID, generation, exact base, observation,
sent record IDs, failure source tokens and projected cursor. The manager checks
the generation again inside the serialized checkpoint. Only matching accepted
observations retire exactly sent failures and advance the cursor. A matching
rejection adopts the receipt baseline and eligible target, retaining a newer
desired revision, then produces a new report. False for a
null observation means no observation was submitted. Old-generation receipts
cannot change the current target, baseline, failures or cursor; a known remote
result keeps its meaning when its local waiter ends.

The shared exchange waits for persistence, prepares current authority and any
bootstrap candidate, collects fresh telemetry, captures and checks the generation,
sends once, then durably accepts the receipt. Foreground reporting and actual
configuration-dependent management use that sequence. Generation changes discard
the old sample. Normal synchronized cycles add no GET; unknown results,
400/protocol failures and capability rediscovery read before constructing another
report. Existing single-flight scheduling, merged triggers and finite prompt
batches remain the report owner's responsibility.

When desired is null, a root-owned preparation pass reads one consistent snapshot
of the current local file and projects the permitted initial import once. The mode
adoption field is Web; tool adoption derives from that candidate or,
without one, from the startup local choices. The
[Web configuration checkpoint decision](2026-11-17-worker-web-configuration-checkpoint.md)
owns unsupported targets and Web-only qualification. The pass has a 60-second
budget, independently of the
report waiter's deadline. Successful Project identity resolutions may be reused
only within the same source hash and authenticated identity; explicit candidate
refusal invalidates them, and the service still performs final permission checks.
Null cycles keep reading the service. An existing target wins, cancels and drains
the candidate. Unknown import results read first. Running connection, credential,
Worker identity and local execution overrides remain frozen; a file naming
another origin or Worker is rejected without switching ownership.

Null, unread and unsupported authority closes new Task and Bot admission. The
coordinator keeps its original resource view so a missing target is not presented
as every Project being removed. A cold restart derives resource coverage from
actual registered Projects and combines original frozen native tuples with any
genuinely applied recovery limit retained in current or historical records. The
snapshot exposes that policy separately as retainedRecoveryLimit, outside its
effective admission configuration. Herdr's frozen tuple deliberately stores only
Agent, model and arguments; omitting the known policy would prevent original
recovery, while borrowing it from a blocked local candidate would invent a new
execution policy. Missing applied facts remain unknown. Original claims,
workspaces, frozen native identity, unfinished stops and failures keep their
owners. A high-origin stop continues through a lower target; excluded Projects
receive current stop verification after the original operation joins, while
reselected preparation waits for that original stop. Initial retained-Project
coverage counts only after the manager accepts it under usable authenticated
authority. Unread, null or unsupported state resets coverage and invalidates its
awaiting pass. Progress and completion remain bound to that pass's reset identity,
so a late accepted result cannot complete a later recovered round or restore old
progress. Normal synchronized report generations do not reset this ownership;
otherwise continuous reporting could prevent the required checks from finishing.
Recovery rechecks the mappings, and cached success does not prove that the current
coordinator observed the resources. Startup identity retries
transient network failures under the instance lock; a transient initial
configuration GET remains unread and recovers through report preparation.
Authentication, protocol, format and deterministic incompatibility errors never
become empty authority.

This decision replaces the Worker counter-order policy deliberately retained by
the [fact separation](2026-11-12-worker-configuration-fact-separation.md) and
[storage recovery](2026-11-12-worker-configuration-storage-recovery.md) decisions.
Those deliveries kept the existing authority policy while establishing truthful
provenance, retained responsibility and checkpoint ownership. It also replaces
the temporary local-execution bootstrap choice in the
[Project isolation decision](2026-11-06-worker-project-isolation.md), whose
complete-inventory and unavailable-Project resource rules remain.
The [Worker design](../../../../docs/design/daynight-worker.md#云端接收与本机提交)
and [reporting design](../../../../docs/design/daynight-worker-reporting.md#配置快照与回执)
own current mechanisms. The wire protocol, server transaction and Web editing
policy retain their existing owners.

## Alternatives

**Remove only the maximum/lower-revision guards.** This does not isolate old
ACKs or stale telemetry, preserve high-origin stopping work through null, or
separate current verification from original facts.

**Clear and rebuild the checkpoint.** This loses stopping responsibility, unknown
outcomes, genuine actual values and failures still requiring confirmation.

**Add a server epoch or accept future-version observations.** This broadens the
database, deployment and consumer contract. A verified canonical read and local
report generations provide the required realignment without that expansion.

**Send all historical facts as the current observation.** Unique keys, revision
constraints and existing storage budgets cannot represent that history, and
relabeling it as the current target would falsify its original source.

## Consequences

Canonical recovery adds local token and candidate lifecycle state, while keeping
the service DTO and transaction. The current schema 10 source representation is
owned by the unknown configuration, Web checkpoint and
[mode adoption](2026-11-18-worker-web-mode-adoption.md) decisions. Schemas 1–9
retain their historical interpretation. Historical origins remain immutable, and
process proof stays distinct from actual-value provenance.
A local candidate can re-establish configuration lost by the service, but cannot
promise to reconstruct the missing cloud value. Temporary candidate failures
close new admission until a valid target exists; original execution and resource
responsibility remain available.

A report's cancellation bounds its wait rather than the shared candidate or a
manager-owned checkpoint. Shutdown must join those owners before releasing the
instance lock. Permanent storage failure can still prevent new facts from
becoming durable, and active system I/O retains the existing shutdown limits.
The exchange exposes actual stages and source/certainty context for the
[configuration diagnostics decision](2026-11-12-worker-configuration-diagnostics.md),
which owns fixed classification, correlation and same-cause summaries. This
projection does not turn logging into recovery state or change public error DTOs.
