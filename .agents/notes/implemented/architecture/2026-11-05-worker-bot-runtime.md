# Agent Note: Worker Bot Execution Evidence and Shared Controller Processes

Status: implemented

## Problem

An independent assistant must launch without a task worktree, retain its native
writer after uncertain process or HTTP results, and keep relay credentials valid
while task discovery sleeps. Reusing task execution records would couple this
lifetime to claim capacity, cleanup prompts and mandatory archives. A spawn
receipt alone cannot establish that the assistant is available to its user.

## Decision

Bot launch uses the existing independent Session and Controller contracts with
no initial user input. The [inventory decision](2026-11-04-worker-bot-inventory.md)
retains ownership of frozen registration and role intent. A separate execution
table in Worker format 9 stores monotonic submission evidence, process identity,
observations and alias ownership. Older Workers reject that format instead of
silently dropping the evidence needed to prevent a second writer.

Task and Bot share only actual spawn, authenticated observation, per-execution
serialization and grant-maintenance mechanisms. Task lifecycle responsibilities
remain in its backend. Bot readiness requires the matching local initialization
and remote synchronized Session, including its native identity.

Discovery and credential maintenance run independently. Per-Bot jobs do not hold
the discovery loop while starting a native provider. The
[runtime design](../../../../docs/design/worker-bot-runtime.md) owns the interfaces,
persistence and cancellation rules.

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

Ordinary cwd and independent input semantics are preserved. Exact registration
and role fingerprints survive response loss and upgrades. Additional local state
is intentional: lost process outcomes retain private sources and alias ownership.

Recovery, orderly Worker shutdown and deletion must consume this same evidence;
this layer does not implement new generations or claim stop proof. Product
entry and assistantHost advertising remain disabled until lifecycle integration.
Controlled tests establish the execution mechanics, not complete live Provider,
browser, or production acceptance.
