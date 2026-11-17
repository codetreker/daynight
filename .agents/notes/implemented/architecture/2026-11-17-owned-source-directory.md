# Agent Note: Owned source directory deletion

Status: implemented

## Problem

Bot private-source deletion depends on the same filesystem identity and removal
rules as retained recording deletion. Keeping those rules in Herdr resource
management couples a retained Bot capability to an unrelated execution backend.

## Decision

The worker's `owned-source-directory` module owns the shared directory removal
operation. Bot and recording callers invoke it directly after establishing their
own authorization and source ownership. The operation retains physical path and
inode checks, refuses links, Git metadata and unsupported entries, and rechecks
identity before mutations. Callers retain their own lifecycle and durability
responsibilities.

## Alternatives

**Duplicate the deletion rules in each caller.** Independent copies could diverge
on identity checks and filesystem error handling, weakening one consumer when
the other is maintained.

**Keep the operation in Herdr resource management.** Bot cleanup would remain
dependent on a backend-specific owner despite using the same general mechanism.

## Consequences

The shared operation can remain with Bot cleanup when recording callers are
removed. Its existing diagnostics and failure behavior remain unchanged; moving
ownership does not grant authorization to delete a source.
