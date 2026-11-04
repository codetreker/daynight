# Agent Note: Worker Shell Readiness During Native Recovery

Status: implemented

## Problem

A still-owned task must continue after its native Agent exits unexpectedly.
Recreating its inactive Herdr workspace can expose a new shell before shell
initialization finishes. A raw `agent.start` then returns `agent_pane_busy` even
though no Agent owns that pane. Repeated startup failures can exhaust the
Worker's process-local execution recovery budget without resuming the task.

## Decision

The Herdr adapter handles shell initialization within the serialized native
`HerdrAgentManager.launch` operation, also used by the legacy `start` path.
It retries only the explicit `agent_pane_busy` rejection for
at most two seconds, with the original operation's cancellation and deadline.
Before each retry it verifies the owned workspace, pane and terminal, requires
that no Agent has appeared, and reads current `pane.process_info`. The
[structured input decision](../simplification/2026-11-04-worker-structured-input-readiness.md)
removes repeated input, discovery and stop cwd metadata comparisons. Every fresh
`agent.start` attempt still checks the original pane's canonical cwd against the
task worktree after caller admission and before submission; shell startup can
change the directory initially supplied by workspace creation. A mismatch is
definitely not-submitted, while a live-agent reconnect bypasses this launch-only
check.
The shell PID must match the foreground process group, and its foreground
process entry must identify a supported shell by name or argv[0]. Missing
evidence or changed ownership cannot authorize another start.

This follows the
[Herdr 0.9.5 CLI protocol](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/cli/agent.rs#L358-L403)
and its
[shell initialization predicate](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/cli/agent.rs#L652-L694).
The server's
[available-shell check](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/platform/mod.rs#L483-L495)
can reject a shell while its startup subprocesses remain in the foreground
group. A snapshot with no Agent alone does not establish shell availability.

The [claim/session decision](../simplification/2026-10-27-worker-claim-records.md)
owns legacy Linux/Windows recovery identity: stop/close an inactive workspace,
recreate the native environment, and resume the saved session ID, or start fresh
when that ID is NULL. On macOS, the
[durable lifecycle](../../../../docs/design/herdr-worker-lifecycle.md) requires
the original stop proof and native conversation identity before a new generation.
Its launch intent is committed before this bounded retry loop; successful launch
still requires persistent native process proof before assignment delivery.
Shell waiting adds no persistent retry permit, changes no generation and sends
no assignment. An unknown launch outcome or a crash cannot authorize replay.
The [Worker design](../../../../docs/design/daynight-worker.md#herdr-与原生会话)
owns the current startup mechanism.

## Alternatives

**Let each busy response consume an execution failure attempt.** A transient
shell startup race then competes with actual native execution failures for the
same limited recovery budget. The adapter can resolve this known rejection
without changing the claim or restarting the Worker.

**Retry every busy or failed launch.** A real foreground program can own the
terminal, and an unknown response can follow a successful launch. Only the
explicit rejection plus current shell evidence establishes a safe retry.

## Consequences

An exited Agent can resume its original conversation through a replacement
shell that initially rejects startup. Successful waiting inside the operation
does not increment Coordinator failures. Healthy Agents retain their connection
and initial assignment delivery semantics.

Shell initialization that exceeds two seconds, missing foreground-group
observations, real foreground work and identity changes remain visible errors
under the existing recovery policy. Cancellation and exhausted operation
budgets stop waiting. The adapter cannot infer shell initialization on platforms
that do not expose the necessary process observations.
