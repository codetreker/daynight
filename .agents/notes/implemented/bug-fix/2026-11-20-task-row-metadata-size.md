# Agent Note: Ordinary Task row metadata size

Status: implemented

## Problem

Platform, execution permission, status labels and stuck warnings compete with Task titles in
ordinary rows, making auxiliary facts harder to scan across personal and project
lists. The same badges also appear in graph, detail and summary contexts with
independent presentation needs.

## Decision

The shared ordinary row assigns these labels and stuck warnings to the metadata role while keeping
ready and dependency-blocked indicators at their existing size. Row-scoped
selectors override project list rules without changing shared badge defaults or
Session button geometry. The [Web specification](../../../../docs/spec/daynight-web.md#项目普通-task-行)
owns the visible contract. This refines the status role mapping in the
[semantic typography decision](../architecture/2026-11-20-web-semantic-typography.md).

## Alternatives

**Keep interface size for all status text.** It preserves the former uniform
status role but gives secondary row facts the same prominence as the title.

**Change shared badge defaults.** Graph nodes, details and summaries would also
change even though their hierarchy and geometry are independently owned.

## Consequences

The later [machine record decision](2026-11-20-task-row-machine-size.md) extends the same hierarchy to Worker records.

Equivalent ordinary rows share the smaller auxiliary text at every viewport and
scale with browser font preferences. Other contexts retain their existing sizes;
browser checks remain necessary for wrapping and Session interaction.
