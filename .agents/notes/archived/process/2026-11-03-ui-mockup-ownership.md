# Agent Note: UI Mockup Ownership

Status: implemented

## Problem

Committed design previews duplicate UI material outside the product and leave
current documents pointing at earlier visual baselines. Reusing production
components does not make a preview part of the application. Tests that exercise
only those previews add maintenance work without validating the delivered product.

## Decision

The [repository instructions](../../../../AGENTS.md#repository-and-document-ownership)
and [documentation conventions](../../../../README.md#documentation-conventions)
prohibit committing UI mockups, `mockui` pages, their resource bundles, and tests
that target them. This includes interactive previews composed from production
components. Local prototypes belong in the task worktree's Git-ignored `.tmp/`;
reviewable prototypes belong in their owning Daynight task's attachments.
The tracked mockups under `docs/design/mockups/` and
`packages/daynight-web/tests/mockups/`, together with mockup-only tests, are
removed. Product component tests and real-service acceptance retain their own
requirements and evidence boundaries.

Current specifications and designs link to their behavior and mechanism owners;
immutable archives retain their historical references. The retained visual-reference
history includes the [authentication architecture](../architecture/2026-10-22-auth-architecture.md),
[authenticated workspace](../feature/2026-10-22-web-auth-workspace.md),
[project task views](../feature/2026-10-22-project-task-views.md),
[project sections](../feature/2026-10-25-project-overview-task-sections.md),
[section restoration](../bug-fix/2026-10-25-project-section-restoration.md),
[graph fullscreen](../feature/2026-10-22-task-graph-fullscreen.md),
[centered details](../feature/2026-10-22-centered-task-detail-dialog.md),
[attachment split view](../architecture/2026-10-22-task-attachment-split-view.md),
[task inspection](../architecture/2026-10-22-task-inspection-design.md), and
[external dependencies](../architecture/2026-10-23-external-dependency-design.md)
decisions. This policy supersedes their prototype repository retention while
preserving their original design rationale.

## Alternatives

No alternative storage policy was considered; this decision adopts the explicit
repository policy.

## Consequences

Mockup pages and their tests no longer form part of the repository. Sharing a
prototype requires uploading its complete resource bundle to the owning task and
checking its attachment references. Product validation continues against product
components and actual services. Historical archive links can name removed
prototype paths; they describe the original decision context and are not current
implementation references.
