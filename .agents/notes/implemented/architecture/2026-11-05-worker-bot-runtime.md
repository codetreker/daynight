# Agent Note: Worker Bot Execution Evidence and Shared Controller Processes

Status: implemented

## Problem

An independent assistant must launch without a task worktree, retain its native
writer after uncertain process or HTTP results, and keep relay credentials valid
while task discovery sleeps. Reusing task execution records would couple this
lifetime to claim capacity, cleanup prompts and mandatory archives. A spawn
receipt alone cannot establish that the assistant is available to its user.
A restart must also distinguish a deliberate healthy shutdown from a failed
writer: counting both as failures exhausts recovery during routine restarts,
while resetting the counter erases evidence of repeated abnormal failures.

## Decision

Bot launch uses the existing independent Session and Controller contracts with
no initial user input. The [inventory decision](2026-11-04-worker-bot-inventory.md)
retains ownership of frozen registration and role intent. A separate execution
table introduced in Worker format 9 stores monotonic submission evidence, process
identity, observations and alias ownership. Format 10 retains recovery provenance,
predecessor stop proof and private paths across generations, and separates the
current Controller instance from the immutable registration. Older Workers reject
the newer format instead of
silently dropping the evidence needed to prevent a second writer.

Task and Bot share only actual spawn, authenticated observation, per-execution
serialization, grant-maintenance and shutdown-error aggregation mechanisms. Task lifecycle responsibilities
remain in its backend. Bot readiness requires the matching local initialization
and remote synchronized Session, including its native identity.

Discovery and credential maintenance run independently. Per-Bot jobs do not hold
the discovery loop while starting a native provider. The
[runtime design](../../../../docs/design/worker-bot-runtime.md) owns the interfaces,
persistence and cancellation rules.

Shutdown joins in-flight management before attempting every original writer's
stop. It retains the Session and journal instead of calling StopTest or requiring
an archive. Process-tree verification and journal stop evidence precede an atomic
transition of the Bot intent and execution row. The next generation retains the
same native Session, role, configuration and operation journal; an unreachable
Controller alone never authorizes replacement.

A fresh healthy observation records orderly shutdown provenance before stopping.
Only that provenance exempts a subsequent error-free stopped generation from an
abnormal recovery increment. Existing counts and blocked reasons survive shutdown
and restart. Recovery-grant response loss is reconciled against the persisted
target fence, not by allocating another generation.

## Alternatives

**Reuse Task backend records.** This would require artificial claim/worktree
identity and import Task completion behavior into a long-lived independent
Session. Dedicated records retain the shared Controller without those policies.

**Treat a failed spawn response as permission to retry.** The child can already
exist after the response is lost. Persisting unknown before spawn and observing
only the original ticket avoids a duplicate native writer at the cost of
retaining unavailable executions until lifecycle recovery can prove termination.

**Renew grants from task polling.** A long task interval or slow startup would
delay authorization for unrelated assistants. An independent maintenance loop
preserves the existing credential threshold without changing task polling.

## Consequences

A spawned recovery child can precede its shared journal generation transition.
Shutdown uses only current-fence snapshots but still attempts to stop the child
from its persisted process birth proof. An unavailable current-generation stop
record remains a reported failure after that attempt.

Ordinary cwd and independent input semantics are preserved. Exact registration
and role fingerprints survive response loss and upgrades. Additional local state
is intentional: lost process outcomes retain private sources and alias ownership.

Recovery and orderly shutdown consume the original process proof and journal;
unknown stop outcomes remain unavailable with their evidence intact. Retained
launch and alias paths make eventual exact deletion possible without touching
the ordinary cwd or shared native home. Formal runWorker Bot scheduling, product
entry, assistantHost advertising and Bot deletion remain separate integration
responsibilities.
Controlled tests establish the execution mechanics, not complete live Provider,
browser, or production acceptance.
