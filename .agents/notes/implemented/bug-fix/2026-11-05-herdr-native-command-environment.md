# Agent Note: Consistent Herdr Native Command Environment

Status: implemented

## Problem

Native preflight resolves Provider commands with the Worker's environment.
Herdr starts the same command names inside an existing interactive shell. A
login shell can reorder PATH and select a different installed Provider, so a
successful version and capability check does not establish that the launched
program supports the required flags. Passing PATH in workspace creation does
not prevent shell startup files from replacing it.

## Decision

New macOS isolated runs use a private executable launcher that execs
`/bin/bash --noprofile --rcfile <private-rc> -p`; Herdr selects `non_login` mode. The shell retains
the prepared environment without loading user profile or rc files. Bash `-p`
also suppresses imported shell functions and shell-option variables, so an
inherited function cannot replace a command selected from PATH; it does not
change the process user identity. Explicit
Agent environment overrides participate in both native preflight and workspace
launch. Native authentication, Provider configuration, and tool subprocess
environment policies retain their existing owners.

Initial managed-shell identity registration requires a per-workspace startup
nonce and a private readiness marker written by the final Bash process. The
daemon and its default pane receive no nonce. The private rc clears inherited
prompt commands, fixes prompt strings, and writes only the expected nonce and
PID using a parent-shell builtin with owner-only permissions and noclobber. No
writer child remains when the marker becomes visible; temporary variables and
the nonce are then removed. No user rc file or external command runs afterward.

The Worker opens the marker with no-follow and nonblocking flags, verifies its
ordinary-file type, owner, permissions, bounded size, and exact contents, and
keeps matching PID, birth, and boot observations around readiness. Startup may
change the audit token before readiness. Once readiness is confirmed, the final
`/bin/bash` image check requires matching PID, birth, boot, and audit token on
both sides. The operation deadline bounds this wait;
a changed birth or boot identity is refused. Subsequent input and stop checks
retain the original registered proof.

This partially supersedes the shell-startup behavior of the
[private adapter decision](../architecture/2026-10-26-worker-herdr-adapter.md).
Linux and Windows retain their existing shared-instance behavior. Existing
macOS daemons reconnect with their original configuration, without rewriting
files or starting another process. An old isolated configuration with no live
endpoints cannot be reused for a new daemon. New-generation directories receive
the managed shell; modified configurations or launchers are refused.

Herdr's supported API fixes the executable name in
[`start_agent`](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/agents.rs#L197-L201)
through
[`interactive_agent_executable`](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/detect/mod.rs#L153).
Its `agent.start` request exposes no executable or environment override.
The [Worker design](../../../../docs/design/daynight-worker.md) owns the current
environment and reconnection contract.

## Alternatives

**Pass PATH only in workspace.env.** Herdr supplies it before shell startup;
the login shell can still reorder it. This leaves preflight and actual command
selection inconsistent.

**Initialize PATH by sending a shell command before agent.start.** That adds a
terminal mutation with its own ownership, acknowledgement and unknown-result
boundaries before native launch. The managed shell removes this extra protocol
and keeps launch under the existing durable admission path.

**Configure an absolute Provider executable in Herdr.** Herdr 0.9.5 has no such
supported configuration or request field. Detection manifests do not override
the fixed interactive executable mapping. Reconsider this option if the upstream
launch API gains an explicit executable contract.

**Wait for matching process samples or the final executable image alone.**
Real macOS execution showed the same shell birth and boot identity with a later
audit-token change after both checks. Neither proves that shell startup has
completed. The final shell's private rc acknowledgement adds user-space startup
evidence without weakening the original process identity checks.

## Consequences

New managed shells select commands from the environment checked by the Worker.
User login customizations no longer affect these shells; installations that
depend on those customizations must provide their required environment to the
Worker. Existing active shells preserve their original behavior until their run
ends. This does not pin executable file contents against later replacement or
establish Provider authentication or prompt acceptance.

The launcher and private rc are created with owner-only permissions. Their
ordinary-file type and exact contents are verified alongside the configuration
before reconnection; the launcher must remain executable. The readiness
directory is private. Original process-stop proofs and unknown
launch/input recovery rules remain required.
