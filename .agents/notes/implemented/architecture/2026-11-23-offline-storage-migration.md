# Agent Note: Offline Local-to-Azure Storage Migration

Status: implemented

## Problem

A stopped local volume contains both retained business objects and temporary
uploads. Copying directories cannot identify which bytes are required, and an
unfinished archive registration would make a client resume against staging that
does not exist on the new backend. A replacement history also has a revision
and a previous completed ledger that must survive revocation of its current file.

## Decision

The offline command reads an untouched paired local volume and a schema-matched
restored destination database. Service orchestration projects destination-only
upload transitions, reuses the Session backup closure verifier to discover
retained objects, and inventories all retained attachments independently of
their owners' visibility. Azure publication is create-only; existing equal
objects can be verified and reused, while differing objects remain conflicts.

Formal-object verification precedes destination metadata settlement. Receiving
archive rows are revoked only when formal publication is absent. An observed
publication without a completed business receipt remains a reported difference.
A failed predecessor retains its public successor receipt and an internal proof
of the successor revocation, so a later run can distinguish the valid unregistered
state from a broken chain. The Controller adopts that confirmed successor using
its saved replacement intent and accepts an ordinary 404 as first-upload state.
Only matching current bundle pointers are cleared; revision, ledger and terminal
receipts remain intact. Image and MCP cleanup settle only destination private
namespaces after confirmed cleanup. The original pair remains a restore point.
The [migration design](../../../../docs/design/offline-storage-migration.md)
owns the command, ordering, failure outcomes and recovery procedure.

## Alternatives

**Copy every directory entry.** This includes discarded staging and still does
not prove business closure. Reclaimed completed history may have only its ledger
and receipt, so blindly requiring every recorded path rejects valid backups.

**Read the destination and then use ordinary overwrite.** A competing create
between the read and write could be replaced. Conditional creation preserves
conflicts without changing ordinary application overwrite semantics.

**Drop the entire unfinished bundle.** This loses completed files, ledger history
and the replacement revision. Narrow file revocation preserves the original
frozen identity and the ordinary first-upload protocol.

## Consequences

Migration requires a maintenance window, an untouched source pair and an isolated
destination. Object copies and database commit remain separate observable
effects; interruption may leave verified target objects for a later run.
Unclassified publication prevents activation. Restoring the pre-cut pair returns
to its old time and requires cache epoch rotation. Azure-write-era paired backup,
automatic rollback and multiple hosts remain separate work.
