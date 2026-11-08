# Agent Note: Atomic Webhook Capture

Status: implemented

## Problem

A Task mutation and the notifications it creates must remain consistent even when configuration, authorization, a process, or the database changes concurrently. Reconstructing an audience or a payload after commit cannot recover the original authorization and destination.

## Decision

Source transactions freeze the complete eligible audience in one statement, prepare immutable event bytes, plaintext destination snapshots and original match proofs, and save all responsibilities before committing. Thread uses its own existing transaction and lock direction. The [capture design](../../../../docs/design/webhook-capture.md) defines the byte, proof and scheduling formats. The [plaintext storage decision](../simplification/2026-11-08-webhook-plaintext-storage.md) replaces the initially encrypted target snapshot without changing its independent lifetime or identity.

## Alternatives

**Capture after commit.** A process failure could lose notifications, and a later configuration or permission snapshot would attribute the event to a different audience.

**Reference current destination and subscription rows.** Edits, deletion or a restored grant could alter the historical request or replace the identities that originally authorized it.

## Consequences

Source writes share the failures and storage cost of capturing their full audience. Existing responsibilities retain the original bytes, destination and authorization proof, while later delivery must separately check continued eligibility. Sender, attempt and retention behavior remain with their respective modules.
