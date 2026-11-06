# Agent Note: Project Deletion Barrier

Status: implemented

## Problem

A Project can contain historical Tasks, files, sessions and execution claims. Removing its visibility without coordinating their writes can leave a claim or a late Session or attachment operation active after deletion, while removing those records would destroy history.

## Decision

Project deletion commits a persistent tombstone and cache epoch with Session retirement in one transaction. It locks the live Project and all its Task rows in UUID order, rechecks current owner Team administration and decodes every stored Worker claim before marking the Project. Task-locked paths check live Project access in a fresh statement after their lock. A bounded local relay ticket retires matching objects only after confirmed commit. The [server design](../../../../docs/design/daynight-server.md) owns the transaction and access mechanisms; the [server specification](../../../../docs/spec/daynight-server.md) owns the HTTP outcomes and preservation guarantees.

## Alternatives

**Delete every Task and file.** This would alter Task history and physically remove files that the deletion contract retains, and would make partial progress observable.

**Check claims before locking Tasks.** A concurrent claim or Task-scoped operation could commit after the check and survive a successful deletion receipt. The shared barrier serializes those operations with the final check.

## Consequences

Deletion cost grows with historical Task and Session counts and can wait for ongoing writes. Reads filter deleted Projects before checking their retained ownership, so a Team with no live Projects can be removed without making an old Project visible or corrupting its historical relation. A confirmed commit is distinct from an unknown outcome and from later local relay cleanup; the retained data is not a recovery API.
