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

Automatic assignment, continuation and cleanup check the original
workspace/pane/terminal and native agent identity, launch state, required
interactive readiness and blocked state. For Codex and Claude, they then read
the bound pane's complete visible text only to reject explicit known menu or
disabled-input patterns. A selected picker row with its source-defined
accept/cancel controls, or a recognized disabled input row, returns a definitely
not-submitted result. Picker controls include selected item actions, secondary
shortcuts, runtime key bindings and wrapped hints. Codex Session pickers can
prune every secondary footer control at narrow widths while retaining a labeled
resume, fork or restore action. That primary-only form requires the complete
Resume/Fork title, a source-defined search or selected session row between the
title and footer, and no later prompt. Search evidence also covers an empty
result list; a selected row remains evidence when an inline error replaces the
search line, including the [expanded selected marker](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/resume_picker.rs#L3070-L3076)
`⌄`. A failed density save can replace search without closing that expanded
picker. The [Session footer packing](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/resume_picker.rs#L2475-L2618)
retains high-priority labeled controls before falling back to key-only hints.
Codex's [picker footer](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/popup_consts.rs#L16-L63)
and [disabled input rendering](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/chat_composer.rs#L4873-L4954)
identify the concrete patterns. Ordinary prose mentioning cancellation is not a
menu, and a later normal prompt excludes stale menu text above it.

Known first-run screens follow the same refusal rule. Codex's welcome screen
with a selected authentication method and its continuation hint, and Claude's
welcome screen with either its selected theme controls or security continuation
hint, are input-owning menus. Their explicit headers and controls distinguish
them from ordinary prose; a later composer excludes stale onboarding text.
Structured readiness can remain true while these screens consume Enter, so
transport completion cannot establish delivery of the automatic assignment.

Automatic and cleanup inspection has no positive composer whitelist, status-bar
or displayed-directory requirement. Normal customized or unknown layouts proceed
immediately after structured readiness; they do not wait for a recognized
normal frame. The macOS inspector reports `composer: "unavailable"`, not a
fabricated empty-composer fact. The read must belong to the requested pane/workspace and be
complete; malformed, truncated or failed observations remain definitely unsent
errors. Any supplied final task authorization guard runs after the visible read
and binding/state recheck, immediately before mutation. Receipt identity, error
propagation and unknown-result handling keep their existing meanings.

On macOS, manual input skips visible-screen exclusions so its lease holder can
operate menus, and also reports composer evidence as unavailable. Explicit handback and
clean orderly automation recovery use the separate `resume` purpose. The
resume-specific `hasEmptyResumeComposer` predicate reads the existing
`pane.read` visible ANSI format with `strip_ansi=false`. Codex requires a current
enabled prompt glyph, its renderer-DIM empty placeholder, blank next input row
and normal keyboard footer. An optional status row needs no particular model,
cwd or status-bar content. Literal text with the same words and multiline
drafts do not prove an empty field. RGB and indexed color parameters cannot
stand in for DIM; unsupported or ambiguous escape/style forms remain unproved.
Claude accepts only a genuinely blank bordered field with its normal footer;
ambiguous `Try` text is not empty-field evidence. A menu, draft or unknown
layout cannot become `empty`.
Copilot retains its unavailable composer evidence and explicit handback
responsibility. The [input arbitration design](../../../../docs/design/herdr-input-arbitration.md)
owns leases, fences, draft dispositions, recovery permission and cleanup priority.

A recognized menu or disabled input is waiting, not an execution failure. It
retains the pending initial assignment or the continuation opportunity without
advancing the submitted-input baseline or consuming execution recovery attempts.
Once the operator closes the blocker, the same bound agent can receive that
input on a later patrol. Previously submitted or unknown input is not replayed.
For macOS, the arbiter preserves the typed blocker after durably recording its
zero-write rejection; the lifecycle projection clears admission and returns an
initial assignment to pending. A write already attempted remains unknown on
failure, rather than becoming a waiting blocker. Existing leases, fences, draft
dispositions and the single durable input arbiter retain their guarantees.

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

**Require a secondary Session footer control.** The original bounded Session
footer pattern required another action beside resume, fork or restore. With a
long primary key binding, the native renderer can prune all those controls even
though the title, search and session list remain visible. Paste then belongs to
search, and Enter can accept a result; transport completion does not establish
assignment delivery. Recognizing the primary-only form with its title and
search/list evidence preserves refusal without treating a lone action as a menu.

**Use an empty-composer predicate for every input purpose.** Returning control
to automation must not accept an unknown field or draft as empty. Applying that
positive proof to ordinary automatic input or cleanup would reintroduce layout
requirements, while applying blockers to manual input would prevent a lease
holder from closing the very menu being handled. Purpose-specific inspection
keeps these responsibilities distinct.

**Treat stripped placeholder words as empty-field evidence.** A literal draft
can contain the same words as an empty placeholder. Resume inspection preserves
renderer attributes and field geometry rather than granting handback from
stripped text. This bounded observation is not an ANSI terminal emulator or a
general proof for unknown renderers.

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

Ready managed agents receive automatic task input and eligible cleanup with
customized or unknown normal layouts. Handback and clean recovery still require
real empty-field evidence for the providers that support it; ambiguous styles
and literal or multiline drafts cannot release control. Recognized menu
and disabled-input blockers wait without exhausting
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
