# Agent Note: Preserve the Worker desired configuration as stored

Status: implemented

## Problem

A stored Worker target can outlive the schema understood by a server. Decoding it
only into the current input type loses unknown fields or makes an otherwise valid
replacement impossible when a stored field no longer matches that type. The
separate archive setting and target revision must remain authoritative.

## Decision

The Worker DAO retains the JSONB target, revision and timestamp independently of
any typed interpretation, and reads the archive setting from its own column.
Capability projection operates on the stored target. A complete PUT validates
its candidate and uses the locked target for comparison, preservation and Project
access; it replaces unknown fields rather than silently treating them as equal.
Explicit bootstrap adoption updates only unadopted fields and preserves the
remaining stored target. The [server design](../../../../docs/design/daynight-worker-configuration.md)
owns the transaction and projection details.

## Alternatives

**Decode and re-encode every stored target using the current type.** Unknown
fields disappear and an incompatible field prevents both reading and repair.

**Reject every target containing unknown fields.** Operators could not inspect
and replace a target after a schema change, even when the new candidate is valid.

## Consequences

Reads and observation-only reports do not rewrite targets. Explicit adoption
retains unrelated stored fields; a complete replacement can remove them and
advances the revision. Project entries that cannot be compared require an access
check. The [archive configuration decision](2026-11-17-worker-archive-configuration.md)
continues to own the independent column and negotiated observation semantics.
