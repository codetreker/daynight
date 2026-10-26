# Agent Note: Submodule Discovery Fixture Lifecycle

Status: implemented

## Problem

The repository-discovery submodule case constructs two repositories, writes a
seed commit and adds a real submodule before looking up its root and origin.
Combining those nine native fixture commands with five discovery reads under
the default test deadline can report a discovery timeout when preparation has
consumed that budget. A faster execution of the same source does not identify
which command was slow or establish an infrastructure failure.

## Decision

The submodule case in `test/repository/git.test.ts` has a case-scoped setup hook
inside its own suite. The hook prepares fresh parent and source repositories,
the native submodule and its origin using the existing commands. The test body
then exercises real root and repository discovery with both original assertions.
No fixture is shared with another case.

The existing Vitest budgets apply to their respective phases: setup uses the
default 10000 ms hook limit, and discovery retains the default 5000 ms test
limit. Each native fixture command retains its 10000 ms limit. Production
operation deadlines, worker scheduling and test configuration are unchanged.
The existing cleanup hook still disposes operations, restores environment and
mock state, and removes every registered private directory, including resources
created during a failed setup.

The fixture isolation described in the
[development guide](../../../../docs/development.md#cli-development) continues to
apply; the [Git validation decision](../../archived/testing/2026-10-18-parallel-git-validation.md)
records the original ownership choices. This case still uses native `git submodule add`, the real
submodule administration file, Unicode and space-containing private paths, and
the configured submodule origin. The
[repository validation guide](../../../../README.md#validation) owns commands and
the distinction between local checks and actual native CI evidence.

## Alternatives

**Increase the test timeout.** That would give construction and discovery one
larger combined budget. Separate lifecycle phases preserve the discovery limit
and expose setup failures as setup failures.

**Replace the submodule with a synthetic administration file.** That would avoid
native Git preparation while losing the actual submodule layout and origin
behavior being verified.

**Prepare a submodule for every repository-discovery case.** Most cases do not
use one. A dedicated nested suite keeps its mutable repositories and extra
commands scoped to the case that needs them.

**Retry the unchanged failure.** The observed whole-case timeout does not
establish a transient external failure. A later pass would not separate fixture
construction from the behavior deadline.

## Consequences

Fixture construction and discovery have explicit lifecycle ownership and
separate existing limits. Native Git behavior and assertion coverage remain
intact. The added setup hook creates no shared mutable seed, process pool,
product fallback or alternate discovery implementation. Slow or failed native
setup and slow discovery remain visible failures in their own phases.
