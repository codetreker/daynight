# Agent Note: Fixed Worker Native Full Access

Status: implemented

## Problem

A worker owns continuous task execution, including restarting a native process
in a newly created task worktree. Native permission prompts can block that
execution before the assigned prompt reaches the business composer. Tool
approval, filesystem sandboxing, directory trust and hook trust are separate
native controls; changing only one leaves another interactive startup decision.
Inherited environment or configurable arguments can also change the policy
between fresh and resumed processes.

## Decision

The [worker design](../../../../docs/design/daynight-worker.md#herdr-与原生会话)
defines a fixed per-invocation full-access policy for both fresh and resumed
Copilot and Codex processes. The argument builder owns the policy and rejects
conflicting configured arguments before a launch RPC. Ordinary model,
reasoning, logging and additional configuration arguments remain available.
The policy has no optional configuration switch or persistence field.

Copilot receives `--allow-all --no-ask-user --no-sandbox` after configured args.
Task workspace creation and native preflight override the inherited environment
with `COPILOT_ALLOW_ALL=true` and `COPILOT_ASSISTED_APPROVAL=false`. The exact
string `true` grants directory trust, including resumed sessions; disabling
assisted approval prevents inherited environment from restoring that mode.
Explicit assisted approval, sandbox, deny-tool/deny-URL and tool-visibility
restrictions are rejected. GitHub's [CLI
reference](https://github.com/github/docs/blob/9568e964d18d76267faf57050dc662c450a13214/content/copilot/reference/copilot-cli-reference/cli-command-reference.md#L734-L774)
documents the flags, and its [environment
reference](https://github.com/github/docs/blob/9568e964d18d76267faf57050dc662c450a13214/content/copilot/reference/copilot-cli-reference/cli-command-reference.md#L887)
documents the full-access environment setting.

Codex retains the worker-owned `--no-daemon [resume <session_id>]` prefix and
appends `--dangerously-bypass-approvals-and-sandbox` and
`--dangerously-bypass-hook-trust`. The last `-c` override supplies a `projects`
inline table whose path entries set `trust_level="trusted"`. The task path is
resolved with realpath and normalized to Codex's native trust-lookup keys before
being encoded as TOML string keys. On Windows, ASCII uppercase characters
become lowercase and the table contains deduplicated regular and
extended/namespaced path spellings. Non-ASCII characters keep their case;
Linux/macOS use one original case-preserving key. Codex's [project-trust
lookup](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/config/src/loader/mod.rs#L1576-L1614)
prefers an exact normalized key before matching other spellings. Writing the
same normalized keys overrides existing lowercase untrusted entries for the
task path.
Node's [Windows
realpath](https://github.com/nodejs/node/blob/v24.19.0/deps/uv/src/win/fs.c#L3044-L3055)
strips drive and UNC namespace prefixes, while Codex's canonical trust lookup
can retain them. Supplying both spellings in the same invocation table makes
either lookup select the trusted entry.
Codex's [typed startup
policy](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/startup_orchestration.rs#L52-L60)
sets full access independently of [directory
trust](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/config_update.rs#L310-L366).
Its [override
parser](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/config/src/overrides.rs#L17-L25)
splits dotted keys, so a quoted dotted-key override cannot reliably identify a
path containing `.worktrees`. The inline-table value keeps the path intact.
Conflicting approval/sandbox controls and duplicate bypass boolean flags are
rejected; the latter also fail native argument parsing when repeated.

Preflight requires Codex 0.135 or newer because the [hook-trust startup
fix](https://github.com/openai/codex/commit/5fb5e47767ac4910f7c208481c23bf4d2fe5cf62)
first shipped in that stable version. Both providers parse the fixed flags in a
bounded read-only `--help` probe. Codex effective-feature inspection uses the
same canonical cwd and final trusted-project override as launch, so trusted
project settings are included. Unsupported versions, flags, hooks or effective
profile inspection fail visibly rather than starting with interactive
permission confirmation.

The policy changes only native invocations and task workspace environments.
Global native configuration, authentication and organization/OS policies retain
their existing owners. Full access does not grant business delivery authority;
managed assignment and task authorization keep their own rules. Input readiness
and supported business-composer checks remain in force, and attach supports
business input. Missing credentials and integration failures remain errors.

This decision partially supersedes the [Herdr
adapter](2026-10-26-worker-herdr-adapter.md) and [manual
control](2026-10-27-worker-manual-control.md) decisions' operator-managed native
consent. Their original rationale remains recorded because terminal readiness
still does not prove that pasted text reaches the business composer. The
[setup decision](2026-10-27-worker-repository-selection.md) retains read-only
inspection and configuration ownership.

## Alternatives

**Handle native trust and permission through attach.** This preserves the
original explicit consent model but blocks unattended execution at each new
task path or native policy prompt. Fixed invocation controls make the selected
worker execution mode consistent across fresh and resumed processes.

**Set only the providers' broad permission bypass flags.** Codex directory
trust is checked separately, and Copilot tool approval does not alone establish
interactive folder trust or disable assisted approval and sandboxing. The
complete provider-specific settings remove those separate startup decisions.

**Persist global trusted paths or permission settings.** That changes later
human invocations and requires editing native-owned configuration. Invocation
overrides and workspace environment provide the required task execution policy
without changing global state.

**Use only the canonical path's original spelling as the trust key.** On Windows
an existing lowercase untrusted entry receives exact-match priority over a
mixed-case trusted override, and Node/Codex can use different namespace-prefix
spellings for the same path. Native key normalization and both Windows spellings
make the final invocation override address the entry Codex actually reads while
preserving case-sensitive POSIX paths.

**Pass Copilot `--trust-folder` for every launch.** Native Copilot limits that
flag to a new prompt-mode session and rejects it with resume/session selectors.
The full-access environment setting covers both worker startup paths.

## Consequences

Fresh and resumed processes use the same explicit full-access request and task
directory trust, independent of inherited approval environment. Configured args
cannot reintroduce supported native permission confirmations. Unsupported native
capabilities fail before business execution rather than silently selecting a
weaker mode.

The worker requires a newer minimum Codex version and owns additional launch
arguments and Copilot workspace environment keys. Composer readiness remains a
separate check; version/argument probes do not establish provider login, real
hook execution, model availability or complete platform acceptance. Native
organization and operating-system enforcement remain external constraints.
