# Agent Note: Isolated Local Development CLI Builds

Status: implemented

## Problem

A development CLI must be testable while the npm CLI remains usable. Shared
credentials, worker identities and local execution records make two installations
interfere even when their executable names differ. Skills use the canonical
`daynight` command, so testing another executable also needs an explicit way to
bind the Agent's commands to the intended build.

## Decision

Repository tooling installs `daynight-dev` as a local snapshot with its production
dependency closure and recorded source identity. The npm package retains only
`daynight` and `dn`. Installation atomically switches the development symlink;
running processes and resolved aliases retain their original snapshots. Local
`update` refuses npm mutation and directs the developer to rebuild.

`DN_CONFIG_DIR` selects configuration and companion local state, defaulting to
`~/.daynight`. The development launcher supplies `~/.daynight-dev` only when no
explicit value exists. All Daynight SQLite, locks, credentials and Controller
records follow this root, without changing the user's actual home. Controller
IPC uses a root-derived identity and a secure short temporary directory when
Unix socket limits require one. Herdr retains its existing native path limit.

This extends the root selection assumed by the [worker storage decision](2026-10-26-worker-local-records.md)
without changing its resource ownership or local-record semantics. The
[configuration manual](../../../../packages/daynight/README.md#configuration-root)
owns the supported path contract and the [development guide](../../../../docs/development.md#local-development-cli-channel)
owns installation and operation.

`agentCliAliases` is an explicit source-to-target mapping. New Worker/Controller
Agent environments receive private executable shims only when configured.
Targets resolve against the original PATH and are pinned by realpath before
injection. Herdr workspaces receive the environment; the persistent daemon does
not inherit an alias PATH that could leak into later unconfigured workspaces.
Codex additionally receives explicit shell-environment policy values for PATH and
DN_CONFIG_DIR; native shell snapshots would otherwise restore a different PATH.
User include filters remain authoritative. The selected configuration root follows mapped commands. Existing workspaces and
processes retain their environment, and releasing an execution does not require
a currently available alias target.

## Alternatives

**Replace the global executable or edit the skill.** Either changes ordinary
stable workflows or makes the skill depend on a particular developer's channel.
Private child environments preserve both the stable installation and skill text.

**Implicit aliases based on the executable name.** This hides command redirection
from configuration. Explicit mapping keeps executable selection independent of
configuration-root selection and makes disabling it observable.

**Separate only config.yml, or change HOME.** The former leaves shared SQLite,
locks and Controller evidence. The latter also changes native credentials, Git
and SSH behavior. A Daynight-specific root avoids both effects.

**Point the development entry at mutable dist and node_modules.** Rebuilding
could change code loaded by an already-running process. Independent snapshots
cost disk space but preserve the executing build, including lazy dependencies.

## Consequences

Defaults remain compatible, and installation neither copies stable state nor
enables aliases. A development CLI can use the same service as the stable CLI;
state-root separation does not isolate remote records, repository worktrees,
Provider histories or installed skills. It is not a security sandbox.

Snapshots and successful shim directories remain until their users have stopped;
there is no automatic garbage collection. Build metadata identifies dirty source
but is not a reproducible source archive. Shell startup files and native Provider
settings can override PATH, so actual shell resolution needs verification.

The local installer and alias shims support macOS/Linux. Windows rejects these
opt-in features explicitly while retaining ordinary CLI and state-root behavior.
Adding Windows launchers requires native quoting and process tests; the mapping
contract and root selection do not depend on POSIX shell syntax. POSIX alias roots
cannot contain `:`, because a private bin directory must remain one PATH entry.
