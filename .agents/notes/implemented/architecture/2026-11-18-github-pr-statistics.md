# Agent Note: Project PR Daily Statistics

Status: implemented

## Problem

Project members need accurate daily counts of all retained pull requests and a selected author, including records outside the displayed window in the project total. A paginated list cannot provide a consistent complete series while records change between pages.

## Decision

The GitHub reader provides a project-scoped statistics read in the same authorized repeatable-read snapshot as connection facts and the selected author's latest saved login. The client supplies bounded UTC intervals for its 30 local dates; the database groups saved creation instants with `width_bucket` into date and outside buckets. The response preserves exact integer strings and distinguishes an unconfirmed empty collection from a confirmed one. The [read design](../../../../docs/design/github-pr-reading.md) owns the protocol and availability rules.

## Alternatives

**Traverse PR pages.** Pages can observe different collection states and transfer all summaries for every filter change.

**Aggregate by server time zone.** The server and browser can have different time-zone database versions and assign the same instant to different dates.

**Maintain aggregate tables or add a date index.** A separate aggregate adds synchronization and recovery work; an index cannot avoid scanning project records for an exact all-time total. The existing project and author indexes remain available.

## Consequences

The read returns bounded aggregate rows without materializing PR summaries, but an exact project total still requires examining the project's retained records. Client-provided segments preserve the browser's date interpretation and must be validated before the query. A selected author's current login and counts describe the same snapshot; no remote GitHub request occurs.
