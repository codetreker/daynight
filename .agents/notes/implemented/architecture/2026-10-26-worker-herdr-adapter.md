# Agent Note: Private Worker Herdr Adapter

Status: implemented

## Problem

A task controller must reconnect to its own terminal resources after interruption
without launching a second native agent or sending the same input twice. Native
terminal status, input acknowledgement and pane closure describe different facts;
conflating them can lose work or delete a workspace while its original agent is
still executing. An inherited human Herdr endpoint or parent native invocation
identity can also route session reports to the wrong execution.

## Decision

The [adapter entry](../../../../packages/daynight/src/commands/worker/herdr.ts)
composes private-instance lifecycle, bounded IPC, native preflight and concrete
task operations. One worker uses one private named session `w`, with independent
task workspaces/panes. The controller retains scheduling, claims, recovery budget,
cleanup deadline and business completion under the
[worker responsibility decision](2026-10-22-worker-design.md).

Private Herdr data stays below the fixed worker `h/` root. Child-only XDG config
and state homes plus HERDR_CONFIG_PATH isolate endpoints, snapshots and config.
Managed config disables onboarding and automatic native-agent restore; existing
modified config is refused. Herdr routing identities and parent Codex invocation
IDs are removed, while native homes, history roots and authentication remain
with their existing owners. The structured attachment descriptor contains only
required routing/native-home overrides and identity removals, not a full copy of
authentication environment values.

Instance readiness checks compatible Herdr version/protocol, a restored snapshot
and both endpoints. An incompatible or uncertain existing server is retained.
A newly started detached server uses file-backed logs and survives a completed
startup operation or controller process exit. A cancelled follower observes its
own cancellation without terminating a shared startup. Stop acknowledgement is
followed by endpoint closure and, where a live owned child handle exists, child
close. A reconnected instance has no such handle; its result does not invent
process-exit evidence or terminate a bare persisted PID.

IPC uses one newline-delimited JSON request per connection, matching response
identity/type, bounded bytes and one operation deadline. Request IDs correlate;
they do not deduplicate. A write may have reached Herdr even when the reply is
lost. Method-specific errors distinguish definite rejection only when that
method's preflight semantics establish it. Unknown mutations are not replayed.

Task labels persist origin/project/task/claim/worktree identity and are joined to
actual workspace/pane/terminal IDs and cwd. Duplicate or ambiguous resources fail
visibly. Native launch queues argv first and verifies the acknowledged target and frozen
arguments. Actual interactive readiness authorizes one initial caller prompt;
the adapter then binds the official native SessionStart reference. Explicit
resume also requires the durable original ID and necessary history, and its
reported ID must match after input. Prompt acknowledgement proves text-plus-Enter
PTY submission, not model receipt or task completion. Per-pane mutations are
serialized.

The controller owns the complete startup and restart prompt, including explicit
worker-managed environment, using-daynight execute-task-in-managed mode and the
original assignment/frozen configuration. The adapter treats it as opaque text,
preserves multiline content and never infers task mode or builds business
instructions. Reconnecting to a live original agent does not resubmit startup
input. A launch starts only from an empty native-reference baseline and returns
HerdrLaunchEvidence after exact target/argv acknowledgement. That evidence binds
the pane, owner, provider, frozen argv and empty baseline. A blocked launch can
continue its initial input only with both matching persisted evidence and the
caller's durable initialPromptNotSubmitted:true fact; a bare flag, reconnect or
unknown submission cannot produce that authorization. A genuinely restarted same-claim agent uses
exact original native history and frozen model/arguments; a new claim starts a
new native session. Verified argv transmission does not establish that an
arbitrary model is available or effective. Native fallback for an unavailable
model is not preservation evidence; effective configuration observations remain
qualified by native version and an actually available model. Later identity-observation failure preserves a separate
promptSubmission fact, including submitted or unknown, so it cannot authorize
replay as never sent. Ordinary submitPrompt still requires an official native
ID; the first-input exception is confined to verified startup/recovery.

An inactive restored shell retaining a native reference returns rebind-required
even when the ID equals the requested original ID. Unverified deferred launch
evidence also requires rebinding. The caller first proves original stop and
closes the old workspace, then prepares a fresh pane through existing rebind
operations while retaining worktree, native ID and frozen configuration. The
adapter neither fabricates nor clears metadata to make an old reference appear
fresh. Launch results and later errors retain evidence beside promptSubmission.

Preflight verifies the native executable and required capabilities, current
installed official integration, effective SessionStart command and its runtime.
It does not install integrations, alter global configuration or silently bypass
hook trust. Current/static integration checks are prerequisites, not proof that a
hook ran. Resume additionally checks an exact readable native manifest ID and
physical cwd. Compressed or ambiguous Codex manifests are refused explicitly.
Native provider databases remain the providers' responsibility; preflight does
not build a history/schema engine or prove full historical context. Actual start
must report the expected official native ID after the authorized first input,
and native qualification separately checks original memory and effective
configuration.

Codex launch uses the system-owned --no-daemon flag to isolate shared human
daemon execution. Its full argv also avoids Herdr's
[shorthand resume pre-recording](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/agent_resume.rs#L116-L216),
so the subsequent native binding still requires the actual official report. Stop captures the original binding/native ID, shell and
nonempty original process observations. The caller must save that observation in
its existing claim record before forcing. Graceful /exit still needs original
process execution to end. After cold restore, a changed shell is accepted only
when original native processes and the replaced original shell are no longer
executing, the current pane has no non-shell foreground work, and original
owner/terminal/cwd bindings still match. An empty restored shell alone is not
stop proof. A launch-pending folder-trust prompt can already host
the native wrapper/binary. Capturing it requires matching managed ownership and
concrete native foreground argv/PIDs; unrelated or empty observations cannot
authorize stopped confirmation. Cleanup does not grant folder trust or change
global configuration. Force stop retains the same owned workspace with a
temporary empty tab/pane, closes the original agent pane, then checks the captured
original processes are no longer executing before workspace closure. Missing
observations, reused/live or inaccessible PIDs and changed identities remain
unconfirmed. The adapter does not certify the disappearance of every possible
escaped temporary tool; agent cleanup and known-process stopping retain their
separate responsibilities.

This implements the Herdr resource side of the worker design without changing
the [local-store](2026-10-26-worker-local-records.md) or
[Git-workspace](2026-10-26-worker-git-workspaces.md) ownership decisions. Git
removal still follows confirmed original-agent stop and workspace closure.

## Alternatives

**Allow Herdr and the worker to both restore native agents.** A layout restore
could launch business work before the worker reads terminal/control intent or
current ownership. Disabling automatic native restoration leaves one native
start/recovery owner while preserving live-agent reconnection.

**Put startup prompt text in agent argv.** Herdr rejects control characters in
native arguments, and multiline instructions need the terminal paste/Enter
semantics supplied by agent.prompt. Separating launch readiness from input also
keeps the acknowledgement boundary explicit.

**Require a new official session ID before the first input.** Codex 0.164 runs
SessionStart lazily when preparing the first user turn for both new and resumed
sessions. Waiting for that report before submitting any input can therefore
prevent the turn that produces it. The pinned sources show
[session-start dispatch](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/session/session.rs#L1990-L2018),
[turn preparation](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/session/turn.rs#L328-L341)
and [hook gating](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/hook_runtime.rs#L127-L169).
Verified target/configuration and explicit resume evidence authorize one input;
the official report supplies the subsequent native binding, while prompt
submission remains a separate retained fact.

**Accept a matching retained native ID as a fresh hook report.** Herdr can
restore that reference with a shell before any native agent is restarted. Matching
identity alone would therefore accept stale metadata. A verified empty-reference
launch baseline, exact argv acknowledgement and explicit deferred-input evidence
make the subsequent report attributable to the new launch. Stale shells require
stop/close/rebind instead of metadata reset or silent adoption.

**Treat prompt or pane-close acknowledgement as completion.** Prompt success is
PTY submission and pane.close can acknowledge while processes survive. Original
process observation and independent stopped confirmation preserve responsibility;
Herdr idle/done remains an execution observation rather than business completion.

**Use Herdr's native restore command as the complete recovery plan.** Its native
reference does not prove history exists or preserve every frozen model/argument.
Explicit resume arguments, minimal manifest prerequisites and the same official
runtime ID supply distinct evidence without a maintained provider-database layer.

**Close the original task workspace to force its agent to stop.** That removes
the resource needed to retain attribution before stop proof. One temporary empty
anchor in the same workspace allows original-pane closure and process inspection
before final workspace closure, without another instance or native agent.

## Consequences

The adapter exposes concrete submission and resource facts without a reporting
protocol, callback service, prompt DSL or another local ledger. A known missing
history, unsupported capability, untrusted/nonreporting hook or unknown input
leaves the original execution available for diagnosis rather than creating a
fresh replacement or repeating input.

The baseline source contract is Herdr 0.9.5 at
[2ecf19a](https://github.com/herdrdev/herdr/tree/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01).
IPC and controlled-process tests are separate from actual native-agent receipt,
configuration/history continuity and stop proof. A real Linux Herdr 0.9.5
trust-blocked Copilot case verified original-process absence after original-pane
closure, an empty same-workspace anchor, subsequent workspace closure and an
unaffected live Codex execution. That establishes the concrete stop path for
that environment, not general model/history continuity. Source-level adapters
and one platform's targeted observations do not establish the foreground
coordinator, managed business instructions, management-protocol revisions or
three-platform whole-Goal acceptance. The earlier Herdr 0.8.2 shell-only smoke
remains evidence only for its original version and environment.
