# Agent Note: Repository Discovery Before Project Creation

Status: implemented

## Problem

Creating a project from an existing Git worktree requires repeating a repository
address that Git already owns. Repeating the command can also register another
project for the same repository even when the configured service already has the
intended project. Equivalent HTTPS, SSH and SCP spellings make raw address
comparison insufficient, and a failed or incomplete lookup must not permit an
unintended write.

## Decision

`daynight project create <name> [--repo <repo>]` accepts an optional repository
address. Without it, creation reuses the existing Git discovery mechanism to read
the current worktree's effective `origin`, including `insteadOf` expansion.
Explicit `--repo` preserves the supplied address and skips working-directory and
Git inspection, so that path remains usable outside a Git repository.

Both forms use the shared repository identity function and complete project
pagination before writing. No match creates a project with the original name and
selected raw address. One match succeeds with `Project already exists.` and the
existing project, preserving its name and address. Multiple matches fail with all
matching IDs. Discovery, pagination, response validation, identity comparison,
cancellation and deadline failures remain failures and stop before creation.
The same bounded operation covers discovery, lookup and any subsequent POST.

This partially supersedes the mandatory address and direct registration behavior
in the [project/task CLI decision](../architecture/2026-10-20-project-task-cli-design.md).
That original contract kept all project operations independent of the caller's
working directory. List, show and explicit-address creation retain that boundary;
inferred creation loads only Git discovery. No project command reads or writes
the task repository binding or ignore rules. The
[requirements](../../../../docs/spec/daynight-project-task.md#pt6-project-命令)
own the observable behavior, and the
[design](../../../../docs/design/daynight-project-task.md#api-映射与更新机制)
owns API sequencing and dependency loading.

## Alternatives

**Enforce repository uniqueness in the service.** This could prevent concurrent
duplicate creation atomically, but would replace the existing service contract
that permits multiple projects for one repository and require API or persistence
changes. The correction stays in the client and reports pre-existing ambiguity.

**Reuse task `resolveProject` for creation.** That resolver writes a repository
binding and ignore rule, treats zero matches as an error and stabilizes a cached
project choice after duplicates appear. Creation needs zero matches to permit a
POST and must inspect current complete matches without changing local state.
Reusing Git discovery and identity comparison retains the shared mechanisms
without adopting task selection and persistence semantics.

## Consequences

Ordinary repository use no longer repeats the origin address, and repeating
creation preserves an existing matching project. Explicit-address scripts use
the same canonical comparison and ambiguity behavior as inferred creation.
Creation now depends on a complete project scan; an error on any page prevents a
POST and produces no successful result or local binding changes.

The service continues to allow duplicate repository registrations. The scan and
POST are separate requests, and pagination is not a cross-request snapshot, so
concurrent creators can still create duplicates. Atomic repository uniqueness
would require a separate service contract, API and persistence decision. This
client correction preserves those service boundaries and does not claim that
guarantee.
