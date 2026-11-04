# Agent Note: Structured Worker Native Input Readiness

Status: implemented

## Problem

A managed native agent can be ready for task input while its terminal uses a
custom status bar, a different placeholder or a different provider layout.
Requiring those presentation details makes valid task delivery depend on text
that the worker neither owns nor needs to route input. Repeated cwd comparisons
also treat mutable terminal telemetry as an additional execution identity after
the worker has selected the task directory and bound its resources.

## Decision

The Herdr adapter uses structured agent observations to admit automatic input.
It checks the original workspace/pane/terminal and native agent identity, launch
state, required interactive readiness and blocked state. It then applies the
caller's final task authorization guard and sends the opaque prompt through
`agent.prompt`. Receipt identity, error propagation, definite non-submission and
unknown-result handling keep their existing meanings.

The adapter does not read terminal text to recognize Codex or Claude composers,
status bars, directory displays, borders, shortcuts, menus or consent screens.
There is no provider-specific visible-text parser or readback validation chain
for input admission. Workspace creation and native launch supply the task cwd;
ordinary input observation, resource discovery and stopping do not require pane
and agent cwd metadata to equal each other or the launch directory. A human
workspace using the same directory does not conflict with a separately owned
task workspace. Workspace creation reports its actual RPC errors; it does not
first scan other workspaces by cwd or use filesystem existence as ownership
evidence. Canonicalizing the launch path for native arguments and Git ownership
checks remain owned by their respective operations.

This partially supersedes the visible-composer and repeated input-cwd checks in
the [private Herdr adapter](../architecture/2026-10-26-worker-herdr-adapter.md)
and the retained composer gate in the [full-access decision](../architecture/2026-10-27-worker-full-access.md).
The earlier guard tried to distinguish a business prompt from a native consent
screen. Fixed worker-owned permission, folder-trust and hook-trust arguments
already control startup policy; Herdr owns structured readiness and blocked
observations. The worker does not maintain a second provider UI recognizer.

## Alternatives

**Expand the visible-text recognizers to accept more layouts.** Adding Git
branch or custom-status variants would resolve individual refusals while
retaining dependence on configurable text, disabled status bars and future
provider rendering changes. It would also keep response-shape and repeated
readback failure paths that exist solely to support that inference.

**Keep cwd telemetry equality as an input gate.** The worker already supplies
the launch cwd and verifies the bound task resources. Requiring mutable pane and
agent cwd observations to match adds no task-routing identity and can reject a
valid existing execution. Stop uses the immutable resource binding and original
process evidence; Git deletion retains its own filesystem ownership checks.

**Reject creation when another workspace has the same cwd.** Directory use does
not identify a task or claim. The worker already identifies workspaces by their
owner coordinates and binds subsequent operations to the resulting IDs. A
global cwd collision scan would prevent a human workspace from sharing a task
directory without proving any resource ownership conflict.

## Consequences

Ready managed agents receive task input independently of their visible terminal
layout and cwd telemetry. Codex and Claude use the same structured admission
path as the other native provider. Structured blocked/not-ready observations,
changed resource identities, revoked task authorization and native transport
errors remain visible and can prevent submission.

The worker relies on Herdr's readiness and blocked observations rather than
independently recognizing native screens. A transport acknowledgement still
proves only PTY submission, not native business processing. Unknown input
outcomes remain protected against automatic replay. Native startup controls and
integration setup remain necessary to run the selected unattended policy.
