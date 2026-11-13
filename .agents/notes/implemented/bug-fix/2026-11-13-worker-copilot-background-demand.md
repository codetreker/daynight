# Agent Note: Worker Copilot Background Demand

Status: implemented

## Problem

A Worker that does not use Copilot can still prepare its Web tool candidate and
attempt assistant-host observation on every background cycle. Missing or failing
Copilot then produces diagnostics unrelated to the Worker's actual workload.
The complete assistant-host protocol still needs a Copilot entry, and omitting
checks must not turn a lack of evidence into an installation or availability claim.

## Decision

Background Copilot preparation follows current effective global and Project
native selections and non-deleted Copilot Bot definitions on the Worker. Project
selections include resolved inheritance; pending, failed and recoverable Bot
definitions remain demand because they may need recovery. Deletion retains its
original cleanup responsibility without creating new demand. A demand transition
invalidates the preparation interval so a newly needed tool can be prepared on
the next cycle. Configuration application, explicit model discovery and new
execution continue to prepare the requested tool independently.

Without demand, a collector may read an existing Web selection and its inspection
proof, but does not resolve, materialize or probe Copilot to report it. Without
such proof it emits the required unavailable entry without a Copilot issue.
Demanded checks retain real errors and all original process cleanup ownership.
The [snapshot specification](../../../../docs/spec/daynight-worker-snapshots.md#助手托管预检)
and [reporting design](../../../../docs/design/daynight-worker-reporting.md#助手托管预检接入)
own the reporting contract and mechanism. This narrows background preparation
in the [frozen tool runtime decision](../architecture/2026-11-12-worker-frozen-tool-runtime.md)
without changing frozen execution identities or probe cleanup rules.

The [read-only channel](../architecture/2026-11-06-worker-readonly-channel.md)
binds its connection to effective configuration, tool targets and local model
overrides, not to inspection proofs. Model requests separately bind the selected
tool identity after preparation. A first on-demand inspection therefore does not
cancel its own result, while later configuration or selection changes still
invalidate the appropriate connection or model snapshot.

## Alternatives

**Prepare every provider in the background.** This ensures a candidate is ready
without waiting for a change in demand, but repeatedly checks an unused tool and
reports failures unrelated to current work.

**Infer demand from tool paths, installation or past successful probes.** A
configured path or a historical observation does not mean the Worker currently
uses Copilot, so it would retain unnecessary checks and diagnostics.

**Use active tool selections alone.** A pending, failed or inactive Bot can still
need recovery without an active selection. Excluding its non-deleted definition
would suppress preparation for that work.

**Bind the read-only connection to inspection proofs.** This would make every
selection change replace the connection, but a first on-demand model query creates
its own proof and would cancel itself. Binding model snapshots to the inspected
selection instead retains identity checks without invalidating that connection.

## Consequences

Unused Copilot does not create new background probe failures, while its required
report entry remains conservative. Enabling demand takes effect on the next
preparation cycle rather than waiting for the old cache interval. An explicit
request can still incur preparation latency and expose actual tool errors. Existing
proof remains historical evidence and does not create demand; neither it nor the
absence of a probe establishes authentication or future execution success.
