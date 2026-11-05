# Agent Note: CLI Test State Isolation

Status: implemented

## Problem

The CLI resolves `DN_CONFIG_DIR` before a supplied home directory. A test can
create a temporary home and still overwrite real configuration, databases or
locks when it inherits that variable from a Worker. A child process built from
the inherited environment has the same exposure. Cleanup that resolves paths
after environment restoration can delete a directory belonging to another
runtime.

A temporary path alone does not establish ownership. A symbolic link can redirect
a write or recursive cleanup outside a fixture, and native SQLite opens bypass
JavaScript filesystem mutation wrappers.

## Decision

The [CLI development guide](../../../../docs/development.md#cli-test-isolation)
owns command usage and the current test environment. Ordinary, acceptance and
stress Vitest configurations load a shared bootstrap before test modules.
The development-installer tests and the Node runner for Python shell-completion
acceptance preload the same CommonJS guard. The standalone sentinel regression
checks its canonical temporary path and retained-state overlap before preparing
its scratch data, then launches guarded probes. The bootstrap performs the same
canonical retained-root preflight before it creates temporary directories.
It clears inherited `DN_CONFIG_DIR` and native home/configuration
overrides, creates private home, cache, GitHub configuration, Windows application
and temporary directories, and retains the original configuration and default
state directories as protected paths. Native defaults follow the isolated home.

The guard permits mutating Node filesystem operations only in the checkout's
`.tmp/` and `packages/daynight/.tmp/`. It checks both lexical containment and the
physical destination through the nearest existing ancestor before mutation.
Open descriptors and `FileHandle` mutations are rechecked. Recursive copies
compose the caller's filter with a check of each included destination, preserving
selection while preventing native copy paths from traversing an unchecked nested
alias. Protected retained-state directories cannot be used even if they overlap
an allowed temporary root. Missing descendants are resolved through that checked
ancestor; symbolic links that escape the permitted root fail before use. A leaf
symlink may be removed when the operation removes the link itself. Hardlink
sources must also be confined so a new fixture link cannot alias external data.

SQLite constructors and backup destinations receive the same path check.
Child-process and native-PTY launches restore isolation metadata and append the
preload even when the caller supplies a restricted environment. Explicit
fixture-level configuration overrides continue to work when they select an
allowed path. The Controller's Unix socket length fallback permits only the
exact short directory derived from a validated fixture state directory. Native
Windows PTYs permit only the pipe names returned by their controlled launch.

Fixtures capture their cleanup directories while they own the configured paths.
The [Bot teardown decision](2026-11-05-bot-fixture-teardown.md) still owns joined
process cleanup and environment-restoration ordering; path checks complement
that lifetime rule. Each Vitest file cleans its registered IPC roots after its
tests. Global teardown and the standalone owning process's exit cleanup remove
the run's private baseline directory and remaining registered IPC roots.
Filesystem wrappers preserve synchronous, callback and Promise failure delivery;
child-process wrappers preserve the promisified execution result. The installed
CLI's configuration precedence and filesystem behavior are unchanged.

## Alternatives

**Clear the variable in each currently affected fixture.** This repairs known
callers but leaves new tests and custom child environments exposed. One shared
bootstrap establishes the baseline before test imports, while fixture-specific
overrides remain explicit.

**Force one global `DN_CONFIG_DIR` for the suite.** Tests that pass different
homes would share the selected state directory, changing their path semantics
and permitting cross-test contamination. Clearing the inherited override keeps
those homes authoritative.

**Wrap only JavaScript filesystem APIs.** Native SQLite constructors and backup
operations do not use those wrappers. They require a separate admission check.

**Use Node's permission model as the only boundary.** Its documented
[filesystem limitations](https://nodejs.org/docs/latest-v24.x/api/permissions.html#limitations-and-known-issues)
allow symbolic links to cross permitted roots, and permission to launch child
processes or native add-ons
does not constrain those operations to the same filesystem roots. The test
preload checks the supported mutation paths and propagates the controlled
environment to actual fixture launches.

## Consequences

An inherited real-state override no longer selects a test's configuration root.
A guarded mutation or cleanup that escapes a fixture fails before it executes,
including paths redirected by symbolic links and native SQLite destinations.
Failures remain test failures. Controlled regression processes can retain
external configuration, database and socket sentinels while exercising the same
parent/child inheritance that caused the exposure.

The safeguard is process-local test infrastructure. It is not an OS sandbox for
arbitrary native commands or add-ons, and it does not prevent another process
from replacing a path between inspection and mutation. Controlled fixture paths
and joined resource cleanup remain required. Supporting a new native writer
requires its own admission check rather than silently expanding allowed roots.
