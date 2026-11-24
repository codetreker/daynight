# Agent Note: CLI Command Loading Split

Status: implemented

## Problem

The information-command import matrix and native executable regressions share a
file. A platform selection cannot classify the matrix independently without
also excluding filesystem, SQLite and process-lifecycle coverage. Each matrix
argument must observe imports from a cold Node process; a shared module cache can
hide an eager import.

## Decision

The information-command matrix runs in `application-command-loading.test.ts`.
Every argument retains its own compiled CLI process, import block list, status
and stderr checks; the matrix checks that home remains absent. The native `application.integration.test.ts`
retains the guarded `review add-repo` configuration write and its executable,
filesystem, SQLite and process-lifecycle cases. A shared fixture creates the
import hook and isolated directory for both tests. Ordinary CI runs both files
on every platform.

## Alternatives

**Keep one file.** A file-level platform selector would also remove native
regressions when excluding the information-command matrix.

**Batch arguments in one process.** Previously imported modules could remain in
the module cache and evade a later argument's import guard.

## Consequences

The split makes the matrix available for a separately reviewed platform
classification. It does not change ordinary CI selection or establish a CI
speedup. The cold process cost remains, and the shared hook is a dependency of
both files.
