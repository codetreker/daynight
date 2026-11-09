# Agent Note: CLI Project Deletion

Status: implemented

## Problem

Deleting a Project affects all its contents, while a lost response can leave the
client unable to tell whether the server committed. A name can contain control
characters or match another Project, so ordinary text confirmation alone cannot
reliably identify the requested operation.

## Decision

The CLI selects a Project by ID or repository, reads the complete deletion
preview, and requires the exact name as a JSON string literal interactively. A
noninteractive caller must supply `--confirm`. The preview does not freeze the
Project's name, ownership or contents: the server checks current permissions and
claims when processing the single DELETE. A validated receipt confirms the
Project ID and deletion; unknown outcomes are not replayed. The
[Project requirements](../../../../docs/spec/daynight-project-task.md) describe
the command's externally visible behavior, and the [server deletion decision](2026-11-06-project-deletion.md)
owns its transaction and retention guarantees.

## Alternatives

**Submit the preview version or name as a condition.** This would turn a
confirmation against accidental selection into a stale-data lock, rejecting an
authorized deletion after ordinary changes to the Project.

**Treat a later 404 as a deletion receipt.** Absence can result from permission
changes or another operation and cannot establish the outcome of this request.

## Consequences

The complete preview can require multiple reads and may change between pages;
its counts are observations. Interactive confirmation supports control characters
without normalizing the name. A confirmed receipt remains meaningful if local
output or cleanup fails, while an ambiguous response requires a new human decision.
