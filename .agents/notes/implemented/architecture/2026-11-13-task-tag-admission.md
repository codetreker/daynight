# Agent Note: Task Tag Association and Response Admission

Status: implemented

## Problem

Task and Goal classification must preserve the original version and execution state while validating every association in the same project transaction. A later legal tag rename can enlarge a full Task response beyond its existing write budget, even if the original short name fit.

## Decision

A dedicated association operation canonicalizes the final set, checks the original Task version and project membership, resolves all identities under the project lock, and touches the Task once only for a real change. The transaction reads actual references for full single-resource results and all existing full write receipts. It does not invoke Worker compatibility or Session transitions. The [server design](../../../../docs/design/daynight-server.md#领域模型与存储结构) owns the transaction and projection details.

For a Task with tags, write admission uses the production bounded encoders on a copy with each name replaced by 64 ampersands and version and update time set to their maximum encoded lengths. Real results retain their values. The reserved name covers JSON escaping of any legal scalar without reading every associated Task body during rename.

## Alternatives

**Measure only current names.** A short name could fit at attachment time and later grow past the response budget after a valid rename.

**Read and re-admit every associated Task on rename.** This makes catalog writes depend on reading all associated Task bodies and scales with their combined size.

## Consequences

The reservation can reject a set whose current names fit, but every accepted association has room for legal renames and subsequent version/time touches. The existing limit remains the boundary; no tag-count quota is introduced. Batch and public association endpoints retain their separate owners.
