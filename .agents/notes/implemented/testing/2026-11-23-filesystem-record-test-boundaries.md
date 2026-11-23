# Agent Note: Filesystem Record Test Boundaries

Status: implemented

## Problem

Synthetic filesystem records and a real Darwin ABI check share a test file.
Selecting that file for native platform coverage also executes the portable
record matrix, preventing the two responsibilities from being selected separately.

## Decision

The synthetic Darwin and Linux record cases remain in
`local-source-filesystem.test.ts`. The Darwin test in
`local-source-filesystem-darwin.test.ts` uses the real `fstatfs` ABI and retains
its platform guard, architecture-specific symbol, file descriptor and cleanup.
The ordinary CI suite continues to discover both files on every platform.

## Alternatives

**Keep the mixed file.** This preserves the existing coverage but cannot select
portable records independently of the native ABI sentinel.

## Consequences

The record matrix can be considered independently for a future portable test
selection while the real ABI remains a native sentinel. This split alone does not
reduce the current CI matrix or establish a wall-clock improvement; any future
selection must verify actual case coverage and platform results.
