# Agent Note: Ask before executing newly registered work

Status: implemented

## Problem

Task registration and execution require separate authorization. A successful
creation or a ready task does not show whether the user wants work to begin.
Returning only a task identifier leaves that decision unstated, while starting
immediately can turn permission to record work into permission to implement it.
Repeated approval requests also interrupt work whose execution was already
explicitly authorized within a known scope.

## Decision

The public skill reports the task identity and current status after creation and
readback. When no explicit execution authorization covers the identified task,
it asks whether to start and waits for an explicit affirmative answer, retaining
todo and performing no task execution before that answer. Refusal ends the
startup proposal; silence remains waiting; an ambiguous answer requires
clarification. Creation, readiness and elapsed time do not authorize execution.
Existing explicit authorization remains effective within its stated scope and
is not requested again or expanded to other work.

The [skill requirements](../../../../docs/spec/daynight-agent-skill.md) and
[design](../../../../docs/design/daynight-agent-skill.md) own the complete
behavior. The shared rule lives in
[SKILL.md](../../../../packages/daynight/src/commands/skill/skills/using-daynight/SKILL.md#shared-constraints);
creation and Goal references apply it at their registration boundary. An
identified, authorized ordinary task enters run-task only when its required
inputs and real prerequisites are complete. Registration never selects a
successor or creates a continuous scheduling loop.

This decision replaces the return-only registration behavior in the
[user-confirmed Goal discussion decision](2026-10-24-user-confirmed-goal-discussions.md)
without changing its stage gates. That behavior preserved the distinction
between registering work and starting it; the explicit question now makes the
remaining user decision visible. Requests to start a discussion and explicit
requirements-to-solution transitions keep their existing scoped authorization.
Solution confirmation permits delivery registration without granting delivery
execution. Starting work does not enable allowAgents, and handoff does not start
execution. Valid worker-managed assignments retain their existing authorization
and explicit launch routing. The
[task/session content decision](2026-10-28-task-session-content.md) keeps the
actual operational authorization and answer history in the session.

## Alternatives

**Return after verified registration without asking.** This prevents implicit
execution but leaves the user to supply a separate start request without being
asked. The explicit question preserves the same authorization gate and makes
the next decision clear.

**Ask again after every creation.** This treats already-authorized work as
unauthorized, adding duplicate approval waits and interrupting valid managed
assignments. Checking the existing task and Goal scope preserves authorization
that already covers the work.

## Consequences

Registration-only requests now include a concrete execution question and wait.
A user can decline or defer work without changing the registered task, while
an affirmative answer remains limited to its identified task and scope. The
same rule applies to normal tasks and the current Goal stage; prerequisites,
inputs, stage confirmations and delivery permissions remain independent gates.

This is an instruction change in the shipped skill, with matching active
requirements, design and existing contract scenarios. It adds no CLI command,
service status, database field or runtime enforcement. Static bundle checks and
independent instruction scenarios establish consistency and packaging; they do
not guarantee compliance by every model or host.
