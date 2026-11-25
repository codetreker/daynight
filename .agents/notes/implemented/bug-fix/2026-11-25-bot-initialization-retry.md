# Agent Note: Bounded Bot Initialization Recovery

Status: implemented

## Problem

A Codex Bot can fail before requesting a native thread. An environment upgrade
removes the original failure but leaves a stopped Controller with no native ID.
The original recovery rule requires that ID, so discovery repeatedly fails
without giving the user a current, actionable reason. Treating every missing ID
as permission to start again would also replace threads whose creation response
was lost.

## Decision

Codex Bot initialization records a versioned dispatch stage in the Controller
journal. The adapter persists `dispatching` before preparing the dirty recovery
barrier for `thread/start`; a failed write prevents that preparation and the
call. Only positive `not_dispatched` evidence permits
another initialization after the original process tree has verifiably stopped.
The original ticket, stopped generation, Session and operation identities remain
owned and retained. Missing fields do not acquire the new evidence by default.

The Worker reserves an attempt and its next deadline before environment
preparation. Failed preparation before generation advancement keeps the service
and local execution on the original generation; successful preparation advances
to exactly one successor. A definite failure of an unsubmitted successor is
persistently blocked instead of creating grant attempts on every discovery tick.
The frozen recovery budget and exponential backoff survive restarts. Unknown
launches and recovery operations retain their existing reconciliation rules.

Bot grant envelopes carry a separate initialization assertion. Both Bot grant
paths require Codex, null original and requested native bindings, no initial
input, and the existing predecessor and actual process-stop proof. Ordinary
Session grant parsing remains unchanged. A started Controller is not represented
as `never_started`.

The exception narrows the original native-identity requirement in the
[Worker execution decision](../architecture/2026-11-05-worker-bot-runtime.md) and
the [hosting reconciliation decision](../architecture/2026-11-20-bot-worker-reconciliation.md).
Those requirements remain necessary for resuming a created native Session.
The [runtime design](../../../../docs/design/worker-bot-runtime.md) owns the
current evidence checks and retry behavior.

An unsubmitted initialization target retains monotonic grant evidence. Deletion
can use the fully revalidated predecessor stop only when the target was neither
launched nor granted, and no unknown grant remains. A minimal deletion witness
survives local cleanup, so a lost receipt response does not lose its identity.
The service still checks the actual fence. An acknowledged target without an
acceptable current stop, or a confirmed mismatch of the predecessor receipt,
retains `execution_evidence_missing` and stops ineffective deletion retries.
Neither case is reported as successful deletion.

## Alternatives

**Retry any stopped generation without a native ID.** A thread can exist before
its response is persisted. This would create a second thread after an uncertain
dispatch and abandon the original operation history.

**Require new dispatch evidence for every old record.** This is conservative but
permanently strands known failures from the old local Codex version gate. A
narrow legacy classifier can instead combine the original ticket and journal,
the exact local failure classification and message, control-flow constraints,
and the absence of contradictory operations or history. The
[shipped adapter](https://github.com/codetreker/daynight/blob/f45556ba950ab921d958d74c97408df3fd42e38d/packages/daynight/src/commands/controller/providers/codex.ts)
passes the same immutable runtime version to preparation before thread creation
and to later protection. Its local version gate therefore cannot first reject
that value during protection. Native RPC rejections carry a different startup
classification; conflicting projection, operations or history still block the
legacy exception. An error string or empty
directory alone is insufficient; unmatched legacy records remain blocked.

**Add a generic reset API or cover all Providers.** Each Provider has a different
creation boundary and recovery material. A reset would need a separate contract
for unknown inputs and existing native sessions. Limiting the exception to
Codex Bots keeps ordinary Task and other Provider behavior intact; they can add
their own positive dispatch evidence later without weakening this rule.

**Relax server `never_started` for any unconsumed initialization grant.** Grant
renewal clears consumption, while connection and source history span generations.
Those fields cannot independently prove that the target generation never ran.
Persisting an additional server generation baseline would broaden this change;
the acknowledged-but-unstarted case instead retains explicit failed cleanup
without repeated stop or completion attempts.

## Consequences

Recoverable initialization failures use the same Bot and platform Session while
retaining the failed generation's facts. Incomplete evidence and exhausted
budgets produce explicit failures instead of unbounded execution retries.
A crash after budget reservation conservatively consumes an attempt. Once
creation preparation starts, even a request that ultimately never reaches Codex remains
unknown unless the original native identity can be recovered.

The legacy classifier assumes the original local records have not been
maliciously rewritten, as do the existing process-stop records. It does not turn
arbitrary missing data into a proof or write a new stage into an old snapshot.
Frozen models and tool selection are preserved, so an independently incompatible
configuration can still exhaust the retry budget.

Failure reporting still requires the actual service fence and current hosting
authorization. If the service retains the predecessor while the local intent
already names its successor, an unreportable failure remains a local diagnostic;
the Worker does not impersonate another generation to update the page.

History snapshot uploads, relay archive behavior and deletion wire protocols
remain unchanged. The implementation does not update a global CLI installation
or a production Worker.
