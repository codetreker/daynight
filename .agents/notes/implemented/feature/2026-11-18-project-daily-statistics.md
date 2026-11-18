# Agent Note: Project Daily Statistics

Status: implemented

## Problem

Project members need to compare daily creation activity without list filters,
pagination, time zone differences, or task associations changing the counts.
Task and pull request reads have different availability and authorization paths.

## Decision

The project statistics section combines the admitted ordinary TaskSync snapshot
and the project PR aggregation in separate panels. Both use the browser's local
30-day UTC interval table and the shared bar chart. Person selections retain
stable account IDs and do not change totals or the all-person scale. The [Web
specification](../../../../docs/spec/daynight-web.md#项目统计) owns visible behavior;
the [Web design](../../../../docs/design/daynight-web.md#项目每日统计) owns the
client mechanisms.

## Alternatives

**Iterate the PR list.** Pagination would add transfers and could combine pages
from different revisions; the bounded aggregation reads one consistent snapshot.

**Compute dates independently on the server.** Differing browser and server time
zone database versions could assign the same instant to different dates; the
browser supplies the intervals shared by both panels.

## Consequences

The two panels can fail and recover independently. Exact PR counts remain
integers through chart rendering. Hourly offset probing relies on the documented
IANA transition spacing; future time-zone data with more than one transition in
an hour requires revisiting this assumption. Older servers leave the PR panel
with a recoverable protocol error while admitted task statistics remain usable.
