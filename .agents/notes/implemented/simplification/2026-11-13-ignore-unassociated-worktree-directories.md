# Agent Note: Ignore unassociated worktree directories

Status: implemented

## Problem

A nonempty scratch directory such as `.worktrees/daynight/.tmp` prevented
repository preparation because migration required every namespace directory to
prove a Git association. The failure blocked unrelated task work and repeated on
each preparation attempt, although the directory supplied no Worker ownership.

## Decision

Migration validates Web-recorded worktrees without enumerating unrelated
namespace directories. The [Web responsibility decision](../architecture/2026-11-17-web-worktree-migration.md)
limits which records may establish a migration candidate. Unassociated directories remain untouched and do not
block preparation, regardless of their names or contents.

This narrows the namespace checks introduced by the
[resource migration decision](../architecture/2026-11-11-worktree-resource-migration.md).
The original conversion protected complete ownership transfer before releasing
legacy locks. Namespace-wide rejection did not establish ownership of unrelated
content and unnecessarily made that content a preparation prerequisite.

## Alternatives

**Require every nonempty namespace directory to prove a Git association.** This
blocks project work when ordinary scratch content is present, even though no
migration or deletion targets that content.

## Consequences

Scratch directories and unassociated former checkout paths no longer prevent
format publication. Their contents and Git metadata remain unchanged. Known
worktrees still require their existing ownership, registration and reciprocal
pointer checks; unreadable resource sources and conflicting ownership remain
errors. Skipping an unknown directory grants no authority to adopt or delete it.
