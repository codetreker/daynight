# Agent Note: Worker Agent Patrol and Shutdown

Status: implemented

## Problem

A live native agent can finish an execution turn while its assigned task still
requires review, CI or subsequent delivery. Reconnecting that process does not
make it resume work. The worker must distinguish this unfinished business task
from an agent that has finished the requested shutdown cleanup.

Cleanup also needs a usable completion signal when native state sequence
counters are absent or do not advance. Requiring both counters can leave an
idle agent occupying its cleanup slot until the full deadline.

## Decision

The [worker design](../../../../docs/design/daynight-worker.md) keeps business
continuation and termination as separate phases of the same claim. Startup and
recovery prompts declare a background assignment, require autonomous decisions
within its scope and existing authorization, and prohibit questions. Waiting
for review or CI remains ongoing execution: the agent waits, checks results and
continues delivery without ending the turn. Task scope and business authorization
remain unchanged. The separate [full-access
decision](../architecture/2026-10-27-worker-full-access.md) owns fixed native
permissions and task-folder trust for fresh and resumed processes.

For a still-owned active claim, a patrol reads the current agent inside the
existing serialized task operation. A live, interactive-ready agent in idle or
done receives a continuation ping when it is not launching and has no first
input pending. Working, blocked, unknown and not-ready states remain under
observation. The ping preserves task, claim, worktree and authorization, and
reminds the agent to wait for review and CI. The agent's state cannot complete
the business task; only its original claim-bound completion does that.

Startup records its original assignment as known unsent in pendingInput before
calling the adapter, with no last-input baseline. An agent.start error does not
make prompt submission uncertain: the matching live ready pane still receives
the pending original assignment, while absent or inactive resources use normal
recreation. Only an explicit unknown agent.prompt result before a successful
receipt moves the input to an uncertain marker. A successful serialized live
reconnect that sends no input clears pending without fabricating a baseline,
so a later patrol can send a continuation ping.

The driver retains the last input's submission baseline in memory. A successful
submission supplies the actual observation read immediately before sending
that input. Startup reports this receipt immediately through onPromptSubmitted,
clearing pending and installing the baseline before native session discovery,
and returns the later observation. Later observations cannot overwrite the
baseline: a turn that finishes before startup returns still constitutes progress
and permits the next patrol ping. A later observation failure preserves the
known receipt and propagates the original error; ordinary pings also record
successful submission before observing again.

An unchanged observation suppresses another ping, including after an unknown
submission result. Later current observations drive the next decision; there
is no persistent input ledger or automatic replay of an uncertain write.
Termination suppresses business pings.

After successful submission of a cleanup message, a subsequent patrol that
observes idle considers that cleanup turn finished and proceeds to stop the
agent and close its workspace. This observation does not require sequence
counter advancement or interactive readiness. The pre-notification observation
and the submission receipt itself do not finish cleanup. Failed or unknown
notification results preserve their error and the existing ten-minute deadline;
they do not trigger automatic replay. Actual process-stop confirmation and Git
ownership checks still precede destructive cleanup.

This decision partially supersedes the cleanup completion criterion in the
[claim record decision](../simplification/2026-10-27-worker-claim-records.md).
Its original counter requirement aimed to distinguish the requested cleanup
from an older business turn. The worker now accepts a fresh idle observation
after successful notification as sufficient for its bounded shutdown phase.
The local schema, claim ownership, recovery and restart guarantees remain with
that decision.

## Alternatives

**Only reconnect a live agent.** It preserves the native process and avoids
startup replay, but leaves an idle unfinished assignment without an instruction
to continue. A dedicated continuation ping preserves that identity while
providing the missing wake-up.

**Keep cleanup sequence-counter baselines.** Both counters can attribute a new
turn when the native integration provides them, but missing or unchanged
counters make an already idle cleanup wait until the deadline. The shutdown
phase uses the requested fresh idle observation and retains actual stopping
confirmation before resource deletion.

**Return startup receipts only with the final observation.** Session discovery
can fail after acknowledged input, preventing the caller from receiving that
receipt. Reporting it immediately preserves the submission baseline while
allowing the original discovery error to propagate.

## Consequences

Review and CI waits remain with the assigned agent. The worker still owns
claim reconciliation and resources, without interpreting business acceptance
or introducing another scheduler, durable journal or public setting. Prompt
instructions cannot prove that a native agent follows the wait policy; native
runtime evidence remains distinct from controlled component checks.

Idle has a phase-specific consequence: it wakes an unfinished active assignment
and finishes an already notified cleanup turn. A fresh idle observation is a
shutdown signal, not proof that the native model consumed the cleanup text.
Unknown notification results retain the deadline. The continuation observation
is process-local, so restarting the worker does not provide exactly-once input.
