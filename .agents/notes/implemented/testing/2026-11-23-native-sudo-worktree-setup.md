# Agent Note: Prepare native sudo tests from registered Worktrees

Status: implemented

## Problem

Existing-state permission and pointer tests use an ordinary Git registration
before making it inaccessible, corrupting an administrative pointer or
denying the final removal. Preparing each from a local bare origin adds
transport and branch preparation to a cleanup proof.

## Decision

The 16 permission and pointer cases create private registered checkouts
with the shared [cleanup fixture](2026-11-18-worker-worktree-cleanup-fixtures.md).
Native Git creates the checkout and administrative registration. The real
manifest store records ownership. Each test starts its original permission,
pointer, identity and cleanup operations from that state, including real
sudo where the case exercises it. The compiled-root, held-child, fetch and
prepare scenarios continue to exercise their existing paths.

## Alternatives

**Share a bare origin between cases.** Setup still includes the remote and
fetch sequence. Each case needs mutable native registration and independent
filesystem state where its permissions and pointers change.

**Use a simulated register or sudo wrapper for cleanup.** The tests own the
actual registration, pointer reads and filesystem permissions. A substituted
cleanup would remove evidence that the OS and Git act on the original worktree.

## Consequences

The cases reduce Git setup commands while retaining platform selection,
real permissions, ownership evidence, diagnostics and cleanup. Per-file and
job performance remain sensitive to the native runner schedule.
