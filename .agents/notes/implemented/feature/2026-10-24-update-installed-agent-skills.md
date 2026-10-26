# Agent Note: Refresh installed agent skills during CLI update

Status: implemented

## Problem

The npm package and an agent's copied skill have separate lifetimes. Updating
the CLI leaves installed task guidance stale, so an agent can follow an older
command or workflow contract even after the executable has changed. Users must
otherwise remember each installation destination and reinstall it separately.

## Decision

`daynight update` synchronizes existing `using-daynight` installations after npm
package verification. Equal or ahead CLI versions synchronize from the retained
package as well, allowing a failed refresh to be retried without reinstalling
npm. A bounded new Node process loads the verified installed code and captures
its bundle, avoiding old-process module caches after package replacement.

Discovery inspects the fixed Agent catalog's User and current Git worktree
Project locations. An existing directory or leaf symbolic link establishes an
installation, including missing entrypoints and dangling leaf links that need
repair. An absent leaf remains absent, and a regular file or inspection error is
reported. Outside Git, only User locations are inspected; a worktree marker
permits the existing Git root resolver. No launcher execution, account access,
project association, installation registry or other-project scan is needed.

The existing full-directory installer remains the publication owner. All selected
physical targets are deduplicated across agents and scopes and checked for
destructive overlap before writes. Replacement removes local edits and obsolete
files, preserves parent links and unrelated skills, replaces leaf links without
changing their referents, and cleans the selected root's legacy skill name after
publication. Results retain all agent/scope labels for a shared target.

Package handling and skill synchronization must both succeed. Skill errors retain
earlier successful targets, stop later targets and return nonzero. The updater
also states whether the npm package was updated or retained; it does not roll
back a verified package. Internal Git commands inherit the refresh supervisor's
process group, which is terminated on interruption, timeout and helper exit;
standalone Git operations retain their independent groups. Normal signal handling
uses the shared installer cleanup; forced supervisor termination cannot promise
stage cleanup or atomic replacement.

This partially supersedes the manual-refresh boundary of the
[public distribution decision](../../archived/architecture/2026-10-21-public-agent-skill-design.md)
and extends the [self-update decision](../../archived/feature/2026-10-20-cli-self-update.md) beyond its
original package-only operation. Package-manager ownership, exact-version npm
installation and new-process version verification remain unchanged.
[Requirements](../../../../docs/spec/daynight-agent-skill.md#as10-cli-更新时同步已安装-skill)
and [design](../../../../docs/design/daynight-agent-skill.md#cli-更新时的自动同步)
own the observable contract and mechanisms.

## Alternatives

**Read the bundle in the original update process.** Reading fresh files can obtain
new bytes, but lazily imported modules after npm replacement can mix old cached
modules with new code. A fresh installed process gives code and bundle the same
package provenance without adding a public command.

**Refresh only when npm installed a newer version.** This leaves skills stale after
a partial synchronization failure. Refreshing retained current/ahead packages
makes the same update command a recovery path.

**Require agent launchers on PATH.** A copied skill can remain installed when its
launcher is temporarily unavailable. Directory-based discovery updates that
installation without inventing an agent-runtime dependency.

**Track or scan every project installation.** No existing installation registry
provides this inventory. Recursive scans widen filesystem ownership and runtime
cost; a registry introduces persistence and migration requirements. The bounded
User/current-worktree scope satisfies local updates. Updating another project
requires running the command there; adding an explicit inventory remains an
additive feature while current discovery stays independent of registry state.

## Consequences

A single update refreshes the supported local copies while preserving missing
installations. Real isolated npm acceptance compares complete installed trees,
checks current/ahead retry and observes a skill failure after successful npm
replacement. Mock launchers fail if executed, and evidence requires their
sentinel to remain absent. Native file evidence does not establish model behavior.

Automatic refresh inherits unconditional replacement, including loss of local
customizations. It does not update copies in other worktrees or repositories.
Shared filesystem targets need one write while reporting every applicable label.
There is no transaction across npm and skill targets: failures remain visible and
completed package or skill writes remain installed.
