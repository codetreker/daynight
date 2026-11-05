# Agent Note: Private Worker Herdr Adapter

Status: implemented

## Problem

A task controller must reconnect to its own terminal resources after
interruption without launching a second native agent or sending the same input
twice. Native terminal status, input acknowledgement and pane closure describe
different facts; conflating them can lose work or delete a workspace while its
original agent is still executing. An inherited human Herdr endpoint or parent
native invocation identity can also route session reports to the wrong
execution.

## Decision

The Herdr adapter retains private-instance isolation, official native integration
and input readiness. On macOS, the [durable lifecycle decision](2026-11-04-herdr-worker-lifecycle.md)
uses one daemon per run, persists original process identities before input, and
recovers stop intents. The [native command environment decision](../bug-fix/2026-11-05-herdr-native-command-environment.md)
uses a managed Bash without user startup files for new macOS runs, while existing
daemons retain their original shell configuration. Other platforms use direct current-resource operations
and call-local stop/input observations under the [simplification
decision](../simplification/2026-10-27-worker-claim-records.md). The
[integration preflight decision](../bug-fix/2026-10-28-worker-integration-preflight.md)
partially supersedes the original refusal to install integrations: runtime
preflight uses the private daemon's official installer for explicitly missing or
outdated integration, then verifies current state and effective hooks. Setup
retains read-only inspection. The
[full-access decision](2026-10-27-worker-full-access.md) replaces the original
operator-managed native folder, hook and tool permission confirmations with a
fixed invocation policy for fresh and resumed processes. The [workspace naming
and identity decision](2026-10-28-worker-workspace-names.md) uses task titles as
mutable display prefixes and four stable UUIDs as owner identity, replacing the
original origin/project/task/claim/worktree label and whole-label name hash.
The [structured input decision](../simplification/2026-11-04-worker-structured-input-readiness.md)
replaces the automatic positive visible-composer layout gate and repeated input, discovery
and stop cwd comparisons with Herdr structured readiness, explicit known
menu/disabled-input exclusions and the original workspace/pane/terminal binding. Fresh starts retain one canonical cwd check
after caller admission and immediately before each `agent.start` attempt.
Native environment reconnection stays read-only; a separate serialized naming
operation may update the display prefix. The original receipts,
history prerequisites, persisted PID provenance and native-consent handling below
explain the earlier recovery design; they are historical rationale rather than
current storage or permission requirements.

### Original implementation and rationale

The [adapter entry](../../../../packages/daynight/src/commands/worker/herdr.ts)
composes private-instance lifecycle, bounded IPC, native preflight and concrete
task operations for Herdr mode. One worker with Herdr responsibilities uses one private named session `w`, with independent
task workspaces/panes. The [foreground
coordinator](2026-10-27-foreground-worker-runtime.md) retains scheduling,
claims, recovery budget and cleanup deadline; the agent retains business
completion under the [worker responsibility
decision](2026-10-22-worker-design.md).

Private Herdr data stays below the fixed worker h/ root. The daemon's private
XDG config/state homes and HERDR_CONFIG_PATH isolate endpoints, snapshots and
config. Managed config disables onboarding and automatic native-agent restore;
existing modified config is refused. Herdr routing identities and parent Codex
invocation IDs are removed. Native homes, provider data and authentication keep
their existing owners.

The facade snapshots the original XDG set/unset values before deriving daemon
environment. Native preflight OS commands restore those original values. Task
workspace and stop-anchor creation forward only the original XDG_CONFIG_HOME and
XDG_STATE_HOME strings, not a complete original environment. Herdr cannot remove
keys from its workspace map, so an originally unset XDG variable is sent as an
empty string, which the [XDG
specification](https://specifications.freedesktop.org/basedir/latest/) defines
as the default-directory case. Private routing, provider-home settings and
HISTFILE remain inherited from the sanitized daemon environment; original
credentials and parent invocation IDs are not copied into the map. Existing live
workspace reconnection is read-only.

HISTFILE points to h/shell.history for daemon children and manual attachment.
Bash/Zsh that honor it write their history there. This does not sandbox shell
profiles: custom rc files may override it, and other shells or APPDATA-based
history are not universally redirected. The structured attachment descriptor
contains required routing/native-home/history overrides and identity removals,
not a full copy of authentication environment values. The [worker attach
command](../feature/2026-10-27-worker-attach-command.md) consumes that descriptor
to connect an interactive client to the existing private instance.

Instance readiness checks compatible Herdr version/protocol, a restored snapshot
and both endpoints. An incompatible or uncertain existing server is retained. A
newly started detached server uses file-backed logs and survives a completed
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

prepareWorkspace returns HerdrPreparedWorkspace with binding and nullable
workspaceEvidence. Only a verified workspace.create acknowledgement produces
HerdrWorkspaceEvidence bound to session/workspace/pane/terminal, ownerLabel and
the exact two-field XDG map. Reconnecting to existing resources or adopting a
creation whose acknowledgement was lost returns no receipt; labels, cwd and
absence of a native reference cannot reconstruct one. Persisted evidence can be
reused after a worker restart only when the same daemon binding and expected map
still match.

Herdr 0.9.5 restores workspace.env as empty, including panes that never launched
a native agent. A restored terminal can therefore inherit private daemon XDG
instead of the task's original authentication locations. Every new native launch
requires its current workspace receipt before preflight or agent.start; missing,
stale-terminal or mismatched map evidence returns rebind-required with
unverified-workspace-environment and performs no launch/input. There is no
receipt cache, environment rename or shell-export adoption protocol.

Task labels originally persisted origin/project/task/claim/worktree identity
and were joined to actual workspace/pane/terminal IDs and cwd. Native launch
queued argv first and verified the acknowledged target and frozen arguments.
The adapter bound the official native SessionStart reference after the first
permitted caller input. Explicit resume required the durable original ID and
necessary history, and its reported ID had to match after input. Prompt
acknowledgement proved text-plus-Enter PTY submission, not model receipt or task
completion. Per-pane mutations were serialized; those receipt and ordering
boundaries remain separate from the input-readiness decision.

The original shared submit boundary additionally read visible Codex and Claude
terminal text before mutation. It required recognized business-composer layouts,
including a nonloading Codex model/directory footer or Claude's prompt borders
and shortcut hints. Recognized trust, authorization, selection and disabled
screens were rejected; unknown layouts waited within the operation budget.
Readback also checked response completeness, pane/workspace/tab association and
terminal/cwd again. The intent was to avoid sending Enter to native consent
screens, as recorded under Alternatives. Custom or cropped footers could not
satisfy that positive predicate even when Herdr reported a ready agent.

The [structured input decision](../simplification/2026-11-04-worker-structured-input-readiness.md)
removes that positive visible-composer whitelist and repeated cwd metadata
comparison. Current automatic input uses Herdr's structured readiness, launch and blocked
states after original workspace/pane/terminal and agent identity verification.
Codex and Claude then read complete bound-pane text solely to reject explicit
known menus or disabled input; customized and unknown normal layouts proceed
without waiting for a recognized composer. The final caller guard follows the
read and binding/state recheck. Known blockers retain pending initial input or a
continuation opportunity without consuming execution recovery attempts. On
macOS, manual menu handling and resume-only empty-field proof remain separate
purposes under the [input arbitration design](../../../../docs/design/herdr-input-arbitration.md);
automatic inspection does not establish an empty composer.
Workspace creation sets the shell's initial directory, and a fresh `agent.start`
attempt checks the original pane's canonical cwd after caller admission and
before submission. That launch-only precondition does not apply to a live-agent
reconnect. Terminal presentation and cwd telemetry do not determine whether an
already-bound task can receive input or stop. Neither an
empty-looking composer nor a ready status changes a submitted or unknown
prompt into a never-submitted one.

The controller owns the complete startup and restart prompt, including explicit
worker-managed environment, using-daynight autopilot-managed-task mode and the
original assignment/frozen configuration. The adapter treats it as opaque text,
preserves multiline content and never infers task mode or builds business
instructions. Reconnecting to a live original agent does not resubmit startup
input. A launch starts only from an empty native-reference baseline and returns
HerdrLaunchEvidence after exact target/argv acknowledgement. That evidence binds
the pane, owner, provider, frozen argv and empty baseline, and embeds the
verified workspaceEvidence. A blocked launch can continue its initial input only
with both matching persisted evidence and the caller's durable
initialPromptNotSubmitted:true fact; a bare flag, reconnect or unknown
submission cannot produce that authorization. Conflicting direct and embedded
workspace evidence is rejected. A genuinely restarted same-claim agent uses
exact original native history and frozen model/arguments; a new claim starts a
new native session. Verified argv transmission does not establish that an
arbitrary model is available or effective. Native fallback for an unavailable
model is not preservation evidence; effective configuration observations remain
qualified by native version and an actually available model. Later
identity-observation failure preserves a separate promptSubmission fact,
including submitted or unknown, so it cannot authorize replay as never sent.
Ordinary submitPrompt still requires an official native ID; the first-input
exception is confined to verified startup/recovery.

An inactive restored shell retaining a native reference returns rebind-required
even when the ID equals the requested original ID. Unverified deferred launch
evidence also requires rebinding. The caller first proves original stop and
closes the old workspace, then prepares a fresh pane through existing rebind
operations while retaining worktree, native ID and frozen configuration. The
adapter neither fabricates nor clears metadata to make an old reference appear
fresh. Launch results and later errors retain evidence beside promptSubmission.

The exact before-native window has a caller-owned stop-proof producer. Before
any possible native launch, the coordinator must durably retain that launch has
NEVER been submitted for the concrete claim/workspace, and revoke that fact
before any operation that could submit one. With the worker as sole native
starter and an actually owned plain pane without pending/native/foreground work,
that durable fact establishes that no agent existed; the caller can then supply
agentStopped:true to existing closeWorkspace and rebind safely. Creation ACK
loss or cold restore before first native launch uses the same producer. Null
references, an empty current pane or this invocation's not-submitted result do
not create the historical fact. Any prior unknown launch forbids this path and
requires original process proof or a pause. The foreground consumer uses
confirmEmptyPane only for current noNativeProcess observation; its durable
never-submitted history remains separate. Concrete stop-only operations also
prove a missing original workspace or an attributable plain replacement using
unchanged old process evidence. No cache or registry supplies historical launch
facts; the coordinator owns storage ordering.

Before dispatch, local argument/preflight failure or queue cancellation can be
reported as definitely not-submitted with the original cause. That result is
about this invocation: an earlier acknowledged launch or deferred input keeps
its existing evidence. The caller may restore a proven undispatched current
attempt, while an earlier unknown launch cannot become never-submitted merely
because a later call was refused.

The original preflight verified the native executable and required capabilities,
current installed official integration, effective SessionStart command and its
runtime.
Every metadata OS command runs with the actual task cwd. Codex feature
inspection retains the frozen -c/--config, --enable, --disable and -p/--profile
tokens and values in their original order, rather than checking unrelated host
defaults. It deliberately required explicit integration installation and left
global configuration and hook trust under operator control, so inspecting an
execution's prerequisites did not silently change later native invocations.
The [integration preflight decision](../bug-fix/2026-10-28-worker-integration-preflight.md)
replaces that installation refusal for runtime starts; the full-access decision
above separately replaces native consent handling. Current/static integration
checks are prerequisites,
not proof that a hook ran. Resume additionally checks an exact readable native
manifest ID and physical cwd. Compressed or ambiguous Codex manifests are
refused explicitly. Native provider databases remain the providers'
responsibility; preflight does not build a history/schema engine or prove full
historical context. Actual start must report the expected official native ID
after the authorized first input, and native qualification separately checks
original memory and effective configuration.

Codex 0.164.0 does not accept profile selection for its read-only features
command. When the selected profile cannot be inspected, preflight reports a
capability error with the original cause and explicit supported-setting advice.
It never drops the profile to query defaults or introduces an effective-settings
configuration engine through TOML, MCP, app-server or SDK. The separate
[integration preflight guard](../bug-fix/2026-10-28-worker-integration-preflight.md)
parses only the installer's projected TOML edit before authorizing a write; native
commands still own effective feature inspection. Like unsupported compressed manifests,
this is an explicit inspection limit, not a promise that every native argument
can be validated.

Codex launch uses the system-owned --no-daemon flag to isolate shared human
daemon execution. Its full argv also avoids Herdr's [shorthand resume
pre-recording](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/agent_resume.rs#L116-L216),
so the subsequent native binding still requires the actual official report. Stop
captures the original binding/native ID, shell and nonempty original process
observations. The caller must save that observation in its existing claim record
before forcing. Graceful /exit still needs original process execution to end.
Ordinary confirmStopped pins the original binding; forceStop remains strict
about that binding and never rewrites old evidence.

Herdr cold restore can retain workspace/pane identity while replacing terminal
and shell. confirmRestoredStop receives the immutable original stop observation
and original binding separately from the actually observed restored binding.
Session/workspace/pane must match; terminal may differ, while owner/cwd remain
pinned. Original native processes and old shell must no longer execute, current
state must be an inactive shell without an active native kind, launch pending or
non-shell foreground work, and any retained reference must still identify the
original native session. The result binds stopped confirmation to the restored
resource. It sends no input, performs no close or kill, and does not combine
edited old PID evidence with a new terminal. An empty restored shell alone is
not stop proof. A launch-pending folder-trust prompt can already host the native
wrapper/binary. Capturing it requires matching managed ownership and concrete
native foreground argv/PIDs; unrelated or empty observations cannot authorize
stopped confirmation. Cleanup does not grant folder trust or change global
configuration. Force stop retains the same owned workspace with a temporary
empty tab/pane, closes the original agent pane, then checks the captured
original processes are no longer executing before workspace closure. Missing
observations, reused/live or inaccessible PIDs and changed identities remain
unconfirmed. The adapter does not certify the disappearance of every possible
escaped temporary tool; agent cleanup and known-process stopping retain their
separate responsibilities.

Original stop observation retains full processIds for process-stop proof and a
required nullable nativeProcessIds role fact for in-place native continuation.
The latter is captured native identity, not the first member of a foreground
list. Unknown legacy roles remain null; their absence does not narrow the full
stop proof or authorize a new conversation or submitted-input replay. Nonnull
roles must be nonempty unique PIDs within the original process set and exclude
the shell. The local store owns explicit migration, not codec guessing.

This implements the Herdr resource side of the worker design without changing
the [local-store](2026-10-26-worker-local-records.md) or
[Git-workspace](2026-10-26-worker-git-workspaces.md) ownership decisions. Git
removal still follows confirmed original-agent stop and workspace closure.

Claude is supported in Herdr mode using its native TUI and exact --resume ID.
Preflight requires the current official SessionStart hook, its documented
matcher, effective settings that permit hooks and exact transcript history.
Automatic input uses Herdr structured readiness and binding checks plus explicit
known native-menu exclusions. It does not require Claude prompt borders or
shortcut hints to identify a positive composer. Parent
CLAUDECODE and CLAUDE_CODE_ENTRYPOINT identities are removed with inherited
Herdr/Codex routing identities. Web Claude uses a separate SDK backend and does
not pass through this terminal adapter.

## Alternatives

**Allow Herdr and the worker to both restore native agents.** A layout restore
could launch business work before the worker reads terminal/control intent or
current ownership. Disabling automatic native restoration leaves one native
start/recovery owner while preserving live-agent reconnection.

**Put startup prompt text in agent argv.** Herdr rejects control characters in
native arguments, and multiline instructions need the terminal paste/Enter
semantics supplied by agent.prompt. Separating launch readiness from input also
keeps the acknowledgement boundary explicit.

**Original visible-composer admission.** Codex
0.164's [directory-trust
caller](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/onboarding/directory_trust.rs#L73-L128)
uses an independent onboarding screen before the business composer. The default
[paste
handler](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/onboarding/onboarding_screen.rs#L80-L83)
does nothing for that trust widget, while its [Enter
handling](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/onboarding/trust_directory.rs#L212-L255)
can choose the highlighted trust action. Thus an ignored paste followed by Enter
can approve native consent instead of submitting the assignment. This is a
separate input owner from the main startup draft/composer pump. Earlier
successful native input/history observations remain scoped to the sessions and
readiness conditions exercised. This motivated the original visible-composer
guard. Its layout-dependent refusal of already-ready managed input is why the
[structured input decision](../simplification/2026-11-04-worker-structured-input-readiness.md)
replaces that positive layout requirement while retaining explicit known menu
and disabled-input exclusions, fixed native startup controls and Herdr's blocked
state.

**Require a new official session ID before the first input.** Codex 0.164 runs
SessionStart lazily when preparing the first user turn for both new and resumed
sessions. Waiting for that report before submitting any input can therefore
prevent the turn that produces it. The pinned sources show [session-start
dispatch](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/session/session.rs#L1990-L2018),
[turn
preparation](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/session/turn.rs#L328-L341)
and [hook
gating](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/hook_runtime.rs#L127-L169).
Verified target/configuration and explicit resume evidence authorize one input;
the official report supplies the subsequent native binding, while prompt
submission remains a separate retained fact.

**Accept a matching retained native ID as a fresh hook report.** Herdr can
restore that reference with a shell before any native agent is restarted.
Matching identity alone would therefore accept stale metadata. A verified
empty-reference launch baseline, exact argv acknowledgement and explicit
deferred-input evidence make the subsequent report attributable to the new
launch. Stale shells require stop/close/rebind instead of metadata reset or
silent adoption.

**Treat prompt or pane-close acknowledgement as completion.** Prompt success is
PTY submission and pane.close can acknowledge while processes survive. Original
process observation and independent stopped confirmation preserve
responsibility; Herdr idle/done remains an execution observation rather than
business completion.

**Use Herdr's native restore command as the complete recovery plan.** Its native
reference does not prove history exists or preserve every frozen model/argument.
Explicit resume arguments, minimal manifest prerequisites and the same official
runtime ID supply distinct evidence without a maintained provider-database
layer.

**Close the original task workspace to force its agent to stop.** That removes
the resource needed to retain attribution before stop proof. One temporary empty
anchor in the same workspace allows original-pane closure and process inspection
before final workspace closure, without another instance or native agent.

**Treat labels or an empty restored pane as environment proof.** Herdr 0.9.5
does not preserve workspace.env during restoration. Even a pre-native pane with
no session reference can lose original XDG auth discovery. A creation receipt
bound to the actual terminal proves which environment was supplied; missing or
stale proof requires safe close/rebind, not inferred adoption.

**Inspect metadata from host cwd or omit unsupported frozen selection.** Task
cwd can select native project configuration and feature/config flags change the
settings actually used at launch. Dropping a profile that features inspection
cannot accept would validate another configuration. The pinned [Codex feature
command](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/cli/src/main.rs#L1977-L2003)
exposes that capability boundary. A diagnostic preserves the request and cause
without a second configuration interpretation engine.

## Consequences

The [current simplification](../simplification/2026-10-27-worker-claim-records.md) owns the delivered storage and restart trade-offs. The original consequences below belong to the detailed model retained here as decision history.

### Original consequences

The adapter exposes concrete submission and resource facts without a reporting
protocol, callback service, prompt DSL or another local ledger. A known missing
history, unsupported capability, untrusted/nonreporting hook or unknown input
leaves the original execution available for diagnosis rather than creating a
fresh replacement or repeating input.

The baseline source contract is Herdr 0.9.5 at
[2ecf19a](https://github.com/herdrdev/herdr/tree/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01).
IPC and controlled-process tests are separate from actual native-agent receipt,
configuration/history continuity and stop proof. Real Linux qualification used
Herdr 0.9.5, Codex 0.164.0 and Copilot 1.0.103 with the available gpt-6.1-sol
model, high reasoning effort for Codex and low for Copilot. Both agents retained
their original official IDs, exact earlier nonce and observed effective settings
after normal and cold recovery. Cold restore kept only new shells and retained
references; the no-input rebind refusal, immutable original stop evidence,
actual restored-terminal proof and fresh empty-reference resume were exercised.
Latest native tool history recorded result writes without reading the old nonce
files. These observations remain version/model qualified rather than a universal
claim about arbitrary native configuration.

The trust-blocked Copilot force path verified original-process absence after
original-pane closure, an empty same-workspace anchor, subsequent workspace
closure and an unaffected live Codex execution. A new Codex claim also received
a distinct native ID. Live reconnection did not submit another prompt. The
unavailable Copilot gpt-5.4 selection/fallback is negative evidence, not
successful model preservation. Codex's observed firstUserMessage normalized one
final submission LF while an independent internal-payload receipt preserved its
bytes; native history representation is a separate boundary from opaque
transport. Native/provider authentication prerequisites must actually be
available; copying a primary auth file alone does not prove an isolated provider
can authenticate.

Actual shell-only regression verified fresh workspace environment receipt and gh
auth status 0. Cold restoration lost workspace.env and produced gh status 1;
adoption had no receipt, and stale or absent proof refused new launch with zero
native launch/prompt attempts or sends. The coordinator's immutable never-launch
fact was saved before workspace creation. With the actually owned plain pane it
authorized safe closure, followed by a fresh receipt, gh status 0 and private
HISTFILE. Read-only CLI regression separately verified task cwd and frozen
feature/config effects, including explicit unsupported profile inspection. No
provider database or configuration interpretation engine was added.

The initial native audit retained three task-owned launch entries appended to
default Bash history without rewriting earlier entries. Current shell-only
qualification observed the unique marker once in private history and zero times
in default history; this does not retroactively turn the initial footprint into
zero writes. The guarantee depends on Linux Bash honoring inherited HISTFILE,
not universal isolation of custom rc files, other shells or APPDATA.

These source adapters and targeted Linux observations do not establish the
foreground runtime's complete behavior, management-protocol revisions or
three-platform whole-Goal acceptance. The foreground runtime independently owns
managed-prompt construction and composition evidence. The earlier Herdr 0.8.2
shell-only smoke remains evidence only for its original version and environment.
