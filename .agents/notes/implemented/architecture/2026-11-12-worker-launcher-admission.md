# Agent Note: Worker launcher admission and upgrade refresh

Status: implemented

## Problem

Normal tool upgrades can change a launcher without changing its ability to run.
A complete Codex loader digest catalogue and exact npm shim templates rejected
unregistered releases and harmless edits before version or capability probing.
A cached selection could also fail once after an in-place upgrade, while a changed
artifact key could leave an earlier probe's cleanup responsibility unresolved.

## Decision

Codex JavaScript entries use the same Worker Node command as ordinary Node
scripts. The loader chooses its native program; the resolver does not enumerate
release bytes or reconstruct its native layout. npm shims supply a target path
from a bounded snapshot, parsed as data without executing shell text. Frozen
recipes are verified against their own command, selection key and recorded files.

New execution candidates whose identity changes are resolved and probed again in
the same operation only after the most recent probe recipe has been reconciled.
That responsibility is retained before probing and independently of the candidate
cache. Reconciliation covers the recipe’s probe scopes across working directories
and environments, and gates late probes of that recipe until cleanup is confirmed. Existing execution recipes and process identities remain frozen. The
[resolution decision](2026-11-11-worker-tool-path-resolution.md) retains the
original identity rationale; the [runtime decision](2026-11-12-worker-frozen-tool-runtime.md)
owns execution and cleanup boundaries.

## Alternatives

**Register the new loader digest.** This fixes only the observed release and
requires another update for every changed distribution or harmless edit.

**Keep exact shim templates.** These reject harmless upstream formatting changes
and couple admission to a complete wrapper rather than the target needed by Node.

**Reconstruct and freeze the selected Codex native.** The original model and Node
flags constrained ambient resolution and detected changes to a selected binary.
Its release-specific layout and bytes nevertheless reject valid new loaders;
letting the actual loader select the native avoids that admission dependency.

## Consequences

Real file, permission, launch and protocol failures remain visible. A new Codex
recipe does not fingerprint a native program dynamically selected by its loader;
recorded files and the existing process ownership mechanisms retain their own
verification and cleanup responsibilities. Unconfirmed old probe cleanup blocks a
replacement probe even when the installation's identity has changed. Existing
frozen recipes remain subject to their own recorded artifacts rather than a new
static reconstruction.
