# Agent Note: Structured Worker Native Input Readiness

Status: implemented

## Problem

A managed native agent can be ready for task input while its terminal uses a
custom status bar, a different placeholder or a different provider layout.
Requiring those presentation details makes valid task delivery depend on text
that the worker neither owns nor needs to route input. Herdr readiness can also
coexist with a native menu where Enter changes a selection. Input admission
needs to reject recognized blockers without requiring a particular normal
composer layout.

Repeated cwd comparisons treat mutable terminal telemetry as an additional
execution identity after the worker has selected the task directory and bound
its resources. A new native launch has a different requirement: the shell
receiving its argv must actually be in the task worktree.

## Decision

The Herdr adapter checks the original workspace/pane/terminal and native agent
identity, launch state, required interactive readiness and blocked state. For
Codex and Claude, it then reads the bound pane's complete visible text only to
reject explicit known menu or disabled-input patterns. A selected picker row
with its source-defined accept/cancel controls, or a recognized disabled input
row, returns a definitely not-submitted result. Picker controls include selected
item actions, secondary shortcuts, runtime key bindings and wrapped hints.
Codex's [picker footer](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/popup_consts.rs#L16-L63)
and [disabled input rendering](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/chat_composer.rs#L4873-L4954)
identify the concrete patterns. Ordinary prose mentioning cancellation is not a
menu, and a later normal prompt excludes stale menu text above it.

There is no positive composer whitelist, status-bar or displayed-directory
requirement. Normal customized or unknown layouts proceed immediately after
structured readiness; they do not wait for a recognized normal frame. The read
must belong to the requested pane/workspace and be complete; malformed,
truncated or failed observations remain definitely unsent errors. Any supplied final task authorization guard runs after the visible read and
binding/state recheck, immediately before `agent.prompt`. Receipt identity, error propagation
and unknown-result handling keep their existing meanings.

A recognized menu or disabled input is waiting, not an execution failure. It
retains the pending initial assignment or the continuation opportunity without
advancing the submitted-input baseline or consuming execution recovery attempts.
Once the operator closes the blocker, the same bound agent can receive that
input on a later patrol. Previously submitted or unknown input is not replayed.
This adds no manual-input lease or separate input arbiter.

Ordinary input observation, reconnection, resource discovery and stopping do not
require pane and agent cwd metadata to equal each other or the launch directory.
A human workspace using the same directory does not conflict with a separately
owned task workspace. Workspace creation reports its actual RPC errors; it does
not first scan other workspaces by cwd or use filesystem existence as ownership
evidence.

Workspace creation supplies the shell's initial cwd. Herdr 0.9.5
[agent.start](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/agents.rs#L197-L224)
writes argv into that existing shell; startup scripts can have changed its
directory. Therefore, immediately before each fresh `agent.start` attempt and
after caller admission, the adapter requires the original pane's current cwd
to canonical-match the task worktree. A mismatch is definitely not-submitted
and sends no native start. Reconnecting to an existing live agent returns before
this launch-only check. Canonicalizing the launch path for native arguments and
Codex trust keys does not itself set the shell cwd. Stop uses immutable resource
binding and original process evidence; Git deletion retains its separate
filesystem ownership checks.

This partially supersedes the positive visible-composer and repeated input-cwd
checks in the [private Herdr adapter](../architecture/2026-10-26-worker-herdr-adapter.md)
and the retained composer gate in the [full-access decision](../architecture/2026-10-27-worker-full-access.md).
The earlier guard tried to distinguish a business prompt from a native consent
screen. The current rule preserves explicit known blockers while removing the
layout whitelist that refused valid managed input. Fixed native permission,
folder-trust and hook-trust arguments retain their startup responsibilities.

## Alternatives

**Expand the positive visible-text recognizers to accept more layouts.** Adding
Git branch or custom-status variants would resolve individual refusals while
retaining dependence on configurable text, disabled status bars and future
provider rendering changes. Unknown normal layouts would still wait or fail.

**Use structured readiness alone.** A ready native process can have an open
picker. Paste and Enter are separate terminal actions; Codex's [onboarding paste
handler](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/onboarding/onboarding_screen.rs#L80-L83)
can ignore text while [Enter handling](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/onboarding/trust_directory.rs#L212-L255)
selects the highlighted action. Rejecting explicit known menus and disabled
input retains that distinction without identifying every normal composer.

**Keep cwd telemetry equality as an input gate.** The worker already verifies
the bound task resources. Requiring mutable pane and agent cwd observations to
match adds no task-routing identity and can reject a valid existing execution.
The launch-only shell check protects the directory in which a new process will
start without imposing a directory gate on an already-bound execution.

**Rely on workspace creation or native trust arguments to set launch cwd.**
Shell startup scripts can change cwd after `workspace.create`, and
`agent.start` writes to the existing shell. Native arguments do not universally
set cwd; Codex's `projects` override configures directory trust. Checking the
original shell immediately before a fresh start preserves the launch guarantee
without adding a launcher or replacing the shell.

**Reject creation when another workspace has the same cwd.** Directory use does
not identify a task or claim. The worker already identifies workspaces by their
owner coordinates and binds subsequent operations to the resulting IDs. A
global cwd collision scan would prevent a human workspace from sharing a task
directory without proving any resource ownership conflict.

## Consequences

Ready managed agents receive task input with customized or unknown normal
layouts. Recognized menu and disabled-input blockers wait without exhausting
execution recovery, and closing them preserves the original input opportunity.
Structured blocked/not-ready observations, changed resource identities, revoked
task authorization and native transport errors remain visible and can prevent
submission. A new native start is refused before submission when its original
shell is outside the task worktree; existing live agents can still reconnect,
receive input and stop after cwd changes.

The blocker set covers explicit supported native patterns, not every future UI
or arbitrary human draft. A transport acknowledgement still proves only PTY
submission, not native business processing. Unknown input outcomes remain
protected against automatic replay. Native startup controls and integration
setup remain necessary to run the selected unattended policy.
