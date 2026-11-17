# Agent Note: Remove Live Terminal Registry

Status: implemented

## Problem

The terminal registry and its project-retirement state handling remain after the
Worker and browser entry points are removed. They retain execution responsibilities
for old Herdr Sessions while uploaded recordings still need independent reads.

## Decision

Remove live terminal registration, state updates, connection binding and their
assembly. Project retirement leaves old terminal state and operation receipts
unchanged while retaining native Session retirement and archive residency. The
historical reader keeps its own record, authorization and integrity checks.

This follows the [control removal](2026-11-18-remove-terminal-control-relay.md)
and [archive write removal](2026-11-18-remove-terminal-archive-writes.md), and
preserves the [history read boundary](../architecture/2026-11-17-terminal-history-read-boundary.md).

## Alternatives

**Retain the registry for old executions.** It would keep a live execution path
whose resources remain the user's responsibility.

**Remove historical records with the registry.** This would prevent access to
already uploaded recordings and discard their original identity and evidence.

## Consequences

The server no longer assembles live Herdr terminal operations. Historical
recordings remain readable under their original permissions; old executions are
not stopped or cleaned up by project retirement.
