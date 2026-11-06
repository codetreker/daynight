# Agent Note: Shared Storage Root Initialization

Status: implemented

## Problem

A directory created by one storage initializer can already be in use by another
initializer before the creator finishes or fails. An empty directory does not
prove that nobody holds an open storage handle. Removing it can invalidate the
other caller's first write even though that caller completed its own durability
barriers. A configured path containing a symbolic link followed by `..` also
depends on component order: lexical cleanup before resolving the link can select
a different storage root and make existing attachments appear unavailable.

## Decision

Initialization never rolls back directory creation by deleting directories.
Every caller synchronizes the resolved root and its readable ancestors before
returning writable storage, including callers adopting an existing directory or
retrying a failed initialization. Opening a parent before creating a child keeps
the existing rule against creating new entries under unreadable parents. Actual
synchronization and close errors remain failures.

Parent extraction during creation preserves the original path components.
Relative paths receive their current-directory prefix without cleaning the
original components. Symbolic links are then resolved into the absolute path
used for both synchronization and opening storage. This also preserves parent
traversal when the current directory itself has a symbolic-link alias. The
[Session design](../../../../docs/design/task-session-protocol.md#完成后的文件归档)
owns the initialization mechanism and permission boundaries.

This partially replaces the rollback decision in
[Completed Session File Archives](../architecture/2026-10-30-session-file-archives.md).
Removing newly created empty directories originally prevented a failed creation
from looking complete on retry; non-recursive removal protected existing files.
Unconditional per-caller ancestor synchronization now provides retry durability,
and retaining directories also protects open handles before their first write.

## Alternatives

**Remove only empty directories.** An adopter can return from initialization
before writing any content. Emptiness does not establish exclusive ownership.

**Add cross-process initialization locks or completion markers.** These require
crash recovery and a persistent coordination protocol. Per-caller synchronization
already establishes the necessary barriers; retaining directories avoids the
destructive ownership assumption without that additional state.

**Only swap absolute-path conversion and symbolic-link resolution.** This fixes
existing roots but leaves parent creation vulnerable to lexical cleanup of `..`.
Creation and opening must preserve the same configured path semantics.

**Use `os.MkdirAll` without per-directory barriers.** It preserves component
ordering but does not establish the required directory durability or reject
creation before discovering that the parent cannot be opened for synchronization.

## Consequences

Failed initialization may leave empty directories. They are retained because
another instance may already use them; no automatic reclamation is introduced.
Every retry pays for the readable ancestor barriers and propagates real I/O
failures. Pre-provisioned search-only ancestors retain their existing operational
durability boundary. This does not add protection against arbitrary external
renaming or retargeting of storage paths while initialization is in progress.
