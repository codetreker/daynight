# Agent Note: Worker software detail width

Status: implemented

## Problem

Tool path details can contain long paths and multiple execution selections. In
the software panel, placing those details inside the right-aligned version
value constrains them to the summary's narrow column and leaves the rest of the
row unused.

## Decision

Reported tool rows use a two-column grid for the name and version summary. A
separate description in the same definition-list group spans both columns and
contains the native disclosure and shared path details. Software-specific styles
belong to the Worker panel; shared path presentation remains owned by the tool
details component. The [tool path decision](../feature/2026-11-12-worker-tool-path-web.md)
describes the facts and interactions retained by both consumers.

## Alternatives

**Keep details inside the version value.** The value's content-sized column
would continue to constrain paths, particularly on narrow screens.

**Take the details out of the row flow.** Positioning or flattening the group
would complicate its definition-list relationship and normal height calculation.
The spanning description preserves both.

## Consequences

Paths use the available row width without changing the reported facts or the
configuration panel. Native disclosures and stable component identity preserve
interaction across unchanged background reads. The layout still depends on the
shared path component to wrap and copy complete values.
