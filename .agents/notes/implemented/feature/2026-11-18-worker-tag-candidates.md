# Agent Note: Worker Tag Candidate Selection

Status: implemented

## Problem

Workers need complete candidate pages across projects when configured with tag
names. Filtering a bounded page after reading it can hide later eligible tasks,
and a configuration change between pages changes the meaning of a continuation.

## Decision

Automatic candidate lists identify the authenticated account's Worker separately
from claim inventory. The authorized snapshot reads its raw target, binds the
normalized name-filter digest and Worker identity to the cursor, and selects
matching task associations before ordering and limiting. Missing configured names
remain in the all predicate. The [server design](../../../../docs/design/daynight-server.md#列表与读取一致性)
owns the query mechanism.

## Alternatives

**Filter after pagination.** Earlier nonmatching tasks could fill a page and
prevent discovery of later matches.

**Resolve names to project tag IDs first.** Dropping a missing name would turn
an all filter into a weaker condition, and IDs do not identify names across projects.

## Consequences

Each candidate page reads the current target in its authorized snapshot. Changes
to filter semantics invalidate an old cursor, so callers must restart the scan.
Claim admission independently rechecks the current target and task tags.
