# Agent Note: Web Worker Assignment and Patrol

Status: implemented

## Problem

An idle Web Agent can finish a turn while its task remains active. A Worker that only observes it cannot remind it to continue, and a resumed execution needs its original assignment and authorization without creating a new conversation. Older live Controllers lack the queued Worker input protocol.

## Decision

Each Worker run and Controller generation establishes the assignment before periodic inputs. Patrol uses the existing tick and the [Controller input admission](2026-11-17-controller-worker-input.md) queue, with transient per-binding state for assignment and uncertain operations. A legacy Controller is adopted only after its original input and native identity are established and its processes are proven stopped; orderly restart preserves the claim, Session and worktree. An inherited initial receipt is reconciled read-only against its original operation and the current ticket-bound journal. Until both the receipt and a fresh same-generation snapshot establish acceptance, no continuation assignment or ping is submitted; rebuilding process-local progress does not replay the initial input. The [inherited input decision](../bug-fix/2026-11-23-worker-inherited-initial-input.md) owns this recovery distinction. The [Worker design](../../../../docs/design/daynight-worker.md) owns the protocol and recovery rules.

## Alternatives

**Deduplicate unchanged idle observations.** A fast completed turn or unchanged observation can still require another reminder, so a baseline would suppress useful patrols.

**Add a separate timer or durable ping ledger.** Existing reconciliation supplies the required cadence; another loop or persistent business state adds coordination and recovery obligations without improving the dispatch fence.

**Send through an old Controller indefinitely.** Its input path lacks the queued final task check. Controlled adoption preserves the original execution while obtaining the new admission protocol.

## Consequences

Repeated eligible ticks produce separate messages and consume model input. The final service read and native dispatch are not atomic, and uncertain outcomes require observation rather than an exactly-once promise. Legacy shutdown retains its existing non-atomic stop window and cannot advance without complete stopping evidence.
