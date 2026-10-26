# Agent Note: User-Home Review Configuration

Status: implemented

## Problem

A persistent reviewer needs one predictable configuration and state location.
Resolving configuration or state relative to the launch directory can select a
different database, cutoff, or session history for the same user's repositories.

## Decision

The [requirements](../../../../docs/spec/daynight-review.md) and
[design](../../../../docs/design/daynight-review.md) specify
`daynight review run` as the review-mode entry point. Configuration is YAML
at `~/.daynight/config.yml`. The program
resolves the current OS user's home directory on Linux, macOS, and Windows.
Manually written relative repository paths resolve against the configuration
directory. The [repository registration decision](../feature/2026-10-18-add-repo-configuration.md)
defines `review add-repo`, its addition-only `repositoryRoot` and the absolute repository
paths it saves. Configuration changes take effect at the next review startup.
The [model options decision](../../implemented/feature/2026-10-22-review-copilot-model.md) adds
independent optional `copilotModel` and `copilotReasoningEffort` strings to the
review projection; server validation remains independent and the existing YAML
update mechanism preserves both fields and comments.

Configuration and coordination state reside under `~/.daynight/`: SQLite and
its sidecar files, retained Copilot sessions, the instance lock, logs, caches,
and temporary files. Repository clones retain their configured paths. PR
worktrees follow the [repository-local worktree decision](2026-10-16-repository-local-review-worktrees.md).
Shared home-path resolution, strict YAML reading and atomic configuration saves
are implemented under `config/`. The review module owns its field projection
and runtime paths; the server projection validates `serverUrl` and optional
`serverToken`. The [project/task design](../../implemented/architecture/2026-10-20-project-task-cli-design.md)
owns the independent HTTP foundation, and the
[credential decision](../../implemented/architecture/2026-10-22-cli-server-credentials.md) owns origin-bound
tokens and POSIX `0600` for credential-bearing configuration. Its original
hidden/stdin acquisition paths are historical; the
[top-level setup removal decision](../../implemented/simplification/2026-10-25-remove-top-level-setup.md)
assigns unattended provisioning to the existing YAML fields.
Review retains its original state locations and does not validate unrelated
server values. Configuration failures identify the fixed filename. YAML parser
failures retain safe category, code and offsets without raw scalar text or
parser causes; other errors preserve their useful cause chains.
The original configuration-loading behavior stopped startup when the file was
absent, making manual preparation an explicit prerequisite. The
[guided setup decision](../../implemented/feature/2026-10-21-guided-configuration-setup.md) partially
supersedes that prerequisite: valid review operations can guide missing repository
configuration before entering their operation. Invalid existing configuration
still stops execution. `review add-repo` and first-use guidance create missing
configuration and update existing YAML without entering review mode. The separate configuration
write lock coordinates
configuration commands while the review instance lock continues to exclude
concurrent reviewers. The [foreground coordinator](2026-10-17-foreground-review-coordination.md)
creates retained state and runs review monitoring under an exclusive instance lock.
The [local status listing](../feature/2026-10-18-review-status-listing.md) reads the
same current configuration and existing database without that lock or runtime
startup. After any required setup, it parses configuration without creating
physical path probes and leaves a missing database absent. SQLite may manage coordination sidecars while reading
existing WAL state.

This location choice complements the
[foreground CLI decision](2026-10-16-foreground-review-cli.md) without changing
its single-process execution or agent-owned publication model.

## Alternatives

**Explicit JSON configuration and a configurable state directory.** The earlier
design proposal used `--config ./daynight.json` and a `stateDir` field. That
allows separate instances, but makes the configuration/state selection depend
on invocation details. The selected fixed user-home layout gives repeated
launches a single configuration, cutoff history, session store, and instance
lock. There is no deployed application data to migrate.

## Consequences

The original home-layout decision included PR worktrees to centralize runtime
files. The repository-local worktree decision replaces that part of the layout;
configuration, coordination state, and retained sessions keep their home location.

Launching from another working directory preserves the same review history and
session identities. YAML examples and path resolution must agree with the fixed
layout. Platform tests must cover home-directory resolution and relative clone
paths; tests inject a temporary home-resolution result rather than write into
an actual user profile. Configuration and coordination files deliberately use the specified home
location, while PR worktrees remain with their repositories and development
probes remain in the task worktree's `.tmp/`.
