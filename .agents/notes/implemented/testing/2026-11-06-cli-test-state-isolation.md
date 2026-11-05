# Agent Note: CLI Test State Isolation

Status: implemented

## Problem

The CLI resolves `DN_CONFIG_DIR` before a supplied home directory. A test can
create a temporary home and still overwrite real `~/.daynight` configuration,
databases or locks when it inherits that variable from a Worker. A child process
built from the inherited environment has the same exposure. Cleanup that
resolves paths after environment restoration can select the real directory.

A temporary path alone does not prevent this damage. A symbolic link can redirect
an operation into the protected directory, and native SQLite opens bypass
JavaScript filesystem mutation wrappers.

## Decision

The [CLI development guide](../../../../docs/development.md#cli-test-isolation)
owns command usage and the current test environment. Ordinary, acceptance and
stress Vitest configurations load a shared bootstrap before test modules.
The development-installer tests and the Node runner for Python shell-completion
acceptance preload the same CommonJS guard. The standalone sentinel regression
checks its scratch path against protected state before preparing data and
launching guarded probes.

The bootstrap records the original homes' `~/.daynight` directories and inherited
`DN_CONFIG_DIR`, clears that inherited override, and creates a private baseline
home and temporary directories. Unrelated provider, cache and application
settings are preserved. Child-process and native-PTY launches propagate the
isolation metadata and append the preload even when the caller supplies a
restricted environment. A child with an explicit safe `DN_CONFIG_DIR` keeps
its supplied home; a child whose default `.daynight` would reach protected state
receives the isolated baseline home. Fixture-specific homes and configuration
overrides retain their meaning.

The guard protects those recorded real Daynight state directories. Before a
write or cleanup, it checks the requested path and its physical destination
through the nearest existing ancestor. Missing descendants inherit that checked ancestor; aliases
through symbolic links cannot bypass protection. Destructive operations that
would remove an ancestor containing protected state also fail. Other filesystem
paths remain available for test fixtures.

The same protection covers mutating Node filesystem calls, writable opens,
tracked descriptors, `FileHandle` mutations, recursive-copy destinations,
native SQLite constructors and backup destinations. Recursive copies compose
the caller's filter with a check of each included destination. Filesystem
wrappers preserve synchronous, callback and Promise failure delivery;
child-process wrappers preserve the promisified execution result.

Fixtures capture their cleanup directories while they own the configured paths.
The [Bot teardown decision](2026-11-05-bot-fixture-teardown.md) still owns joined
process cleanup and environment-restoration ordering. Global teardown and the
standalone owning process's exit cleanup remove the run's private baseline
directory. The installed CLI's configuration precedence and filesystem behavior
are unchanged.

## Alternatives

**Clear the variable in each currently affected fixture.** This repairs known
callers but leaves new tests and custom child environments exposed. One shared
bootstrap establishes the baseline before test imports, while fixture-specific
overrides remain explicit.

**Force one global `DN_CONFIG_DIR` for the suite.** Tests that pass different
homes would share the selected state directory, changing their path semantics
and permitting cross-test contamination. Clearing the inherited override keeps
those homes authoritative.

**Confine every test mutation to repository temporary directories.** This
requires exceptions for native IPC, caches and filesystem probes unrelated to
protecting real Daynight state. Protecting the retained directories directly
gives fixtures access to the other paths their behavior requires.

**Wrap only JavaScript filesystem APIs.** Native SQLite constructors and backup
operations do not use those wrappers. They require a separate admission check.

**Use Node's permission model as the only boundary.** Its documented
[filesystem limitations](https://nodejs.org/docs/latest-v24.x/api/permissions.html#limitations-and-known-issues)
allow symbolic links to cross permitted roots, and permission to launch child
processes or native add-ons does not constrain their filesystem access. The test
preload checks the supported mutation paths and propagates the isolated
environment to actual fixture launches.

## Consequences

An inherited real-state override no longer selects a test's configuration root.
Guarded writes or cleanup that reach the recorded real Daynight state fail before
they execute, including symbolic-link aliases and native SQLite destinations.
Failures remain test failures. Controlled regression processes retain
configuration, database and socket sentinels while exercising the parent/child
inheritance that caused the exposure, and verify that unrelated paths remain
usable.

Protection is process-local test infrastructure focused on real Daynight state.
Arbitrary native commands and other add-ons do not gain a filesystem sandbox,
and another process can still replace a path between inspection and mutation.
Joined fixture cleanup remains required. A new native writer that can access
protected state requires its own admission check.
