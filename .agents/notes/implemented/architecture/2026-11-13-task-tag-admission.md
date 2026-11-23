# Agent Note: Task Tag Association and Response Admission

Status: implemented

## Problem

Task and Goal classification must preserve the original version and execution state while validating every association in the same project transaction. A later legal tag rename can enlarge a full Task response beyond its existing write budget, even if the original short name fit.

## Decision

A dedicated association operation canonicalizes the final set, checks the original Task version and project membership, resolves all identities under the project lock, and touches the Task once only for a real change. Creation resolves the selected set under the same lock, inserts the resource and associations in one transaction, and reloads and verifies the actual references before response admission. It does not touch the new Task a second time. The transaction reads actual references for full single-resource results and full write receipts. The dedicated association operation does not invoke Worker compatibility or Session transitions. The [server design](../../../../docs/design/daynight-server.md#领域模型与存储结构) owns the transaction and projection details.

For a Task with tags, write admission uses the production bounded encoders on a copy with each name replaced by 64 ampersands and version and update time set to their maximum encoded lengths. Real results retain their values. The reserved name covers JSON escaping of any legal scalar without reading every associated Task body during rename.

## Alternatives

**Measure only current names.** A short name could fit at attachment time and later grow past the response budget after a valid rename.

**Read and re-admit every associated Task on rename.** This makes catalog writes depend on reading all associated Task bodies and scales with their combined size.

**Write metadata and tags separately.** Two transactions could expose half a request and increment the Task version twice; a shared project transaction preserves the caller's single version decision.

**Create first and attach tags afterward.** A failed second write would leave a resource without the requested classification and expose it between writes. Creation uses the existing transaction for both.

**Load tags per Task.** A query per selected row grows with page size and can lose the snapshot guarantee if performed outside the original read scope.

## Consequences

The reservation can reject a set whose current names fit, but every accepted association has room for legal renames and subsequent version/time touches. The existing limit remains the boundary; no tag-count quota is introduced. REST PATCH and MCP task updates use the dedicated operation for tag-only requests and combine metadata and associations under the same project transaction otherwise, including partitioned dependencies. MCP full and summary projections use the same actual references for output and admission. Batch reads load references for the selected rows in the same snapshot.
