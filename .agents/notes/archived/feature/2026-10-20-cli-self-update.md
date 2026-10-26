# Agent Note: CLI Self-Update

Status: implemented

## Problem

An installed CLI needs a direct way to obtain the registry's current release.
The executable being used can belong to a different npm prefix from the one
selected by current configuration. A successful installation into another prefix
would leave that executable unchanged. Local dependencies, temporary executions,
source checkouts and other package managers also own different installation
layouts and replacement behavior.

## Decision

`daynight update` updates only the npm global installation containing the running
package. Existing user and current-worktree skill copies are synchronized under
the later [installed-skill update decision](../../implemented/feature/2026-10-24-update-installed-agent-skills.md).
The stable `main.ts` entry supplies the package directory to the nested
updater; it resolves that physical directory, confirms the package name and bin,
derives the platform's global prefix and verifies that prefix's npm-owned
launcher points to the package's `dist/main.js`. A mismatched layout or launcher
fails with original-package-manager guidance before installation. npm's
[global folders](https://github.com/npm/cli/blob/b888cc9a9ff34a8b023ff47b784692396635397b/docs/lib/content/configuring-npm/folders.md)
define the package and executable paths. Windows launcher resolution uses
[read-cmd-shim](https://github.com/npm/read-cmd-shim/blob/9887cf0f2416f05b41cd3318b8fce08d21a20d4e/lib/index.js).

The updater runs npm's JavaScript entry point with the current Node.js executable.
Both metadata lookup and installation use global mode and the verified explicit
prefix, with the child working directory outside the replaced package. User and
global npm registry/authentication configuration remains active; the caller's
project `.npmrc` does not affect global updates, as specified by
[npm configuration](https://github.com/npm/cli/blob/b888cc9a9ff34a8b023ff47b784692396635397b/docs/lib/content/configuring-npm/npmrc.md#L61-L77).
The command queries `latest`, validates canonical SemVer and compares precedence.
Equal or newer installed versions succeed without installation. A newer target
is passed to npm as an exact version, with `--engine-strict --force=false` and
streamed installer output. The updater never elevates privileges. If replacement
is needed while the caller's directory is inside the package, it reports that
the command must be rerun from an external directory.

After npm succeeds, the updater rereads the manifest, verifies package identity,
bin and target version, rechecks launcher ownership, then executes the installed
absolute CLI in a new process and requires an exact `--version` match. Only those
checks complete package-update verification. The verified installation then runs
its skill refresh in a new process, also used when the package is current or
ahead. Only successful package handling and skill synchronization permit overall
success. Help and argument validation precede the operation; update dispatch
precedes configuration and review runtime loading. Review operation dependencies
load only when their selected operations run, so the updater itself does not load
the SQLite native addon it may replace. No review state, sessions or locks are
opened.

The [requirements](../../../../docs/spec/daynight.md#c4-自更新) own observable
behavior, and the [design](../../../../docs/design/daynight.md#npm-全局自更新)
owns mechanisms. The [repository validation guide](../../../../README.md#validation)
owns repeatable acceptance commands and receipt meanings; the corresponding PR
and CI run retain execution evidence for their tested revision. Package
publication remains the independent manual
[trusted-publishing workflow](../process/2026-10-20-npm-trusted-publishing.md).

## Alternatives

**Run a bare `npm install --global @codetreker/daynight@latest`.** This can target
the current default prefix rather than the running installation, producing a
second copy and a misleading success. It also lets the mutable tag choose a
version again during installation. Explicit physical ownership and an exact
resolved version keep the command's result tied to the invoked executable.

**Print an update command for the operator to run.** Delegation avoids managing
installation ownership but does not provide the requested self-update behavior.
The command performs the operation and returns npm's permission or installation
errors, while retaining original-manager guidance for installations it cannot own.

**Manage pnpm, linked packages, local dependencies and temporary executions.**
These cases need their original manager's ownership and replacement semantics.
Support is an additive capability only while the updater rejects foreign
installations before mutation; rewriting them into npm global copies would make
later support require untangling mixed ownership. Their explicit refusal preserves
that constraint. A manager-specific ownership resolver and installer would be
needed to accept another installation type.

## Consequences

Operators can update the installed npm CLI without review configuration,
GitHub CLI or an Agent launcher. The original package-only update required no
Git; automatic skill synchronization now uses Git only when a worktree marker is
found, and works outside repositories without invoking Git. A changed default prefix and caller-directory project
configuration cannot silently redirect the operation. SemVer comparison prevents
downgrades, and fresh process verification tests the new executable rather than
an already loaded version value. Native acceptance uses isolated real npm global
prefixes and a controlled registry, without changing the operator's installation.

npm owns replacement, rollback behavior and concurrent installation handling.
The command does not promise atomic rollback or unchanged original files after a
failure. Network, permission, engine, installer and verification failures remain
errors. It does not stop or restart running reviewers; they use their loaded
version until manually restarted. Windows can reject replacement of a native
addon held open by such a process, and that npm failure remains visible.
