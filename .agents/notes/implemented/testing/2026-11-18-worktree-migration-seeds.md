# Agent Note: Worktree Migration Repository Seeds

Status: implemented

## Problem

The legacy Worktree migration tests create the same starting Git repository
for each fixture. Five native commands initialize a ref backend, configure
commit identity, add a tracked file, and commit its original bytes. None of
those commands creates the linked checkout or migration evidence under test.
The full file took 15.88 seconds in a
[macOS PR run](https://github.com/codetreker/daynight/actions/runs/44236745547/job/134574720067).

## Decision

The [migration test file](../../../../packages/daynight/test/commands/worker/worktree-migration.test.ts)
owns lazy seeds for the `files` and `reftable` backends. Git initializes them
without system templates, since template hooks and sample files are not migration
inputs. Only a primary checkout, its refs, objects, and local identity are
copied. Each case copies independent files, resolves its own Git directory with
Git, and creates real registrations, legacy locks, and case-specific migration
and SQLite evidence. The seed root is released with the test file and case roots
keep their existing cleanup. For both backends, mutation of a private checkout,
ref, and commit object checks that the sibling and seed stay unchanged.

This follows the
[Worker Git fixture ownership decision](../../archived/testing/2026-11-04-worker-git-fixture-seeds.md).
The creation and migration suites have separate source contents and fixture
lifetimes.

## Alternatives

**Share one mutable repository or copy a registered worktree.** Refs, lock
metadata, and on-disk registration identity are migration inputs. Sharing them,
or copying checkout pointers tied to a different root, invalidates the test.

**Reuse the creation suite's fixture.** It has remote setup and a different
starting checkout. Migration needs neither a remote nor shared suite state.

## Consequences

Only immutable startup work is amortized. Original scenarios retain their
native commands, assertions, failure injection, and process interruption checks.
Two added tests cover copy isolation; the entire file remains in ordinary CI.
