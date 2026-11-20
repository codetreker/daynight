# Agent Note: Hide the absent Session hint on manual Task rows

Status: implemented

## Problem

An ordinary Task that does not permit automatic execution can have a confirmed
absence of a current Session. Showing that absence on every such row adds noise,
while other Session observations and admitted entries remain meaningful for the
same Task. Project and personal lists need consistent behavior without confusing
an unknown or failed observation with confirmed absence.

## Decision

The shared Task row passes its own `allowAgents` value to the Session status
presentation. When that value is false and the observation is `no_session`, the
presentation omits the absence text. The later
[unified status decision](../simplification/2026-11-20-unified-task-row-status.md)
uses the lifecycle phrase when no other observation text remains. Automatic Tasks
retain the absence text. Attention and an independently admitted Session entry
remain available, and other states
retain their distinctions. The source observation and its admission are not
changed. The [Session status design](../../../../docs/design/task-session-status.md)
owns the display conditions.

The [shared row](../architecture/2026-11-15-shared-project-task-row.md) and its
[personal integration](../architecture/2026-11-15-personal-shared-task-row.md)
provide the same permission and observation inputs for all ordinary rows.

## Alternatives

**Change the observation or its producer.** Turning a confirmed `no_session`
into a missing observation would lose the distinction from unknown or failed
reads and alter consumers beyond the row. The condition belongs to presentation.

**Apply the condition separately in each list.** Project and personal adapters
already supply the same facts to the shared row; separate conditions could diverge
and would duplicate a single display rule across list owners.

## Consequences

Manual Tasks with a confirmed absent Session no longer reserve a blank status
item, while the lifecycle, permission, Worker and navigation facts keep their
separate meanings. Changes in permission or observation update the same row
without an extra request or timer. Summary rows and graph nodes retain their own
rules.
