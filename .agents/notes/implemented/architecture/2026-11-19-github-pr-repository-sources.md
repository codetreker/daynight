# Agent Note: GitHub PR Repository Sources

Status: implemented

## Problem

A Project can retain observations from different GitHub repositories. PR numbers are unique only within a repository, and replacing a connection must not overwrite an earlier observation or attribute it to the new repository. Existing clients also require a stable interpretation of unqualified reads and cursors.

## Decision

Store verified repository identities per Project and key observations by Project, repository ID and number. Publication and terminal discovery use the active lease's repository; unqualified reads use the source fixed during migration or the first verified connection. The [storage design](../../../../docs/design/github-pr-storage.md) describes the migration, indexes and deployment boundary.

## Alternatives

**Key observations by Project and number.** Different repositories can reuse numbers, so publication would overwrite history and discovery would treat another repository's PR as already known.

**Make unqualified reads follow the current connection.** A repository switch would silently change existing responses and the interpretation of previously issued cursors.

## Consequences

Historical observations remain readable independently of connection state and preserve their source identity. The source directory and composite indexes add storage and write cost. Migration requires trustworthy existing identities and a window without old writers; missing identity aborts the transaction instead of guessing. Explicit source selection is a separate capability.
