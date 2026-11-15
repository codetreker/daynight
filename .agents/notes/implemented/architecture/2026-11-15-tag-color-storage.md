# Agent Note: Tag Color Storage

Status: implemented

## Problem

Project members need a persistent shared color for each Tag while existing clients rely on strict Tag and Task response shapes and previously admitted Task response sizes. Concurrent edits and incremental synchronization must observe the same catalog state.

## Decision

Each Tag stores a canonical uppercase RGB color, with existing and newly created entries defaulting to `#9AA3B2`. A versioned update can change name and color together under the existing project write lock. Actual changes touch associated Tasks and Goals and rotate the catalog epoch in the same transaction. An authorized snapshot resolves requested IDs to their exact versions and colors or identifies missing IDs, with an optional epoch condition. REST writes accept color, and a separate bounded REST projection exposes the snapshot results; existing Tag and Task protocol projections remain unchanged. The [server design](../../../../docs/design/daynight-server.md#领域模型与存储结构) describes the storage and service responsibilities.

## Alternatives

**Add color to every existing Tag reference.** Strict released clients reject unknown fields, and previously admitted Task responses may exceed their encoding budget. An independent projection keeps those contracts intact.

**Download the complete catalog.** Catalog size is unbounded, and paginated catalog reads also calculate usage. Resolving requested IDs avoids relying on a partial catalog or fetching unrelated entries.

## Consequences

Color changes incur the same set-based association touch and epoch rotation as renames. The migration fills existing rows and enforces the stored format, so reads do not synthesize defaults. Clients need a separate color projection and must reconcile its epoch and version with other reads. The MCP adapter does not yet expose the new service capability.
