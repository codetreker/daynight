# Agent Note: Task Current Read Visibility

Status: implemented

## Problem

Task detail panels keep their children mounted while another tab is selected.
Execution ownership alone therefore permits complete Session current reads from
hidden views. Stopping a component's normal timer does not cover discovery,
identity-admission waiting or final archive binding. Treating hidden content as an
invalid execution would disrupt healthy channels, drafts and history positions.

## Decision

Task current-read visibility requires both the selected Session tab and a visible
document. The native client starts with this gate closed; panel commits and
visibility events synchronize it before availability can discover a Session.
The gate is separate from execution ownership, authentication and transport.
The visible three-second startup/report observation, not-registered discovery,
retry, archive checks, controls and Worker report storage retain their owners.

The three native current call sites share a Task-only cancellable flight and check
visibility before requesting and after waiting. Hidden reads and admission-queued
reads are cancelled without freeing their flight until it settles. Deferred
initial/reconnect and archive-binding work resumes under the current execution;
a healthy native channel instead resumes its existing observation cadence.
Archive-ready receipts still require final fence and content verification.
Completed discovery checks visibility again after identity admission and retains
cancelled flights across immediate reopening or claim replacement.

Herdr retains its existing hidden-channel and control lease release policy.
Independent Test/Bot authority observation is unchanged. Application identity
pause and native sixty-second suspension remain separate mechanisms. The
[requirements](../../../../docs/spec/task-sessions.md#task-详情的完整-current-读取)
and [design](../../../../docs/design/task-session-protocol.md#task-current-的读取可见性)
own the caller-visible behavior and implementation.

## Alternatives

**Use execution ownership for visibility.** Losing ownership invokes the existing
pause/disconnect path and changes protected-content and draft handling. A hidden
panel still belongs to its current execution.

**Stop only the component timer.** Archive finalization and requests waiting for
identity admission can reach current outside that timer; all call sites need the
same request visibility and cancellation rules.

**Replace current observation with Task metadata.** That changes the existing
startup-report source and update cadence. Restricting the existing observation to
its actual reader preserves those business rules and the complete response.

## Consequences

Unselected Task panels and hidden documents no longer initiate complete current
reads. Selected visible readers retain their startup, discovery, recovery,
controls and archive behavior. Healthy native channels and reading state survive
ordinary hiding without an unconditional reconnect. Cancellation may require
transport settlement before another full read can begin, so immediate reopening
can wait for that settlement. Actual identity, execution or permission loss
continues the existing isolation policy.
