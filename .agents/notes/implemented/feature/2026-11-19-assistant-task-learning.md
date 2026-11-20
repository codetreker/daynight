# Agent Note: Assistant Task Outcome-Based Learning

Status: implemented

## Problem

Assistants that repeatedly handle the same kind of item do not get better at
it. What an assistant learns lives in its Session context, which is compacted,
evicted from the bounded Session cache, or replaced when another Bot takes
over the task. Existing work records say what was done but not whether it
worked, so neither the assistant nor the user can tell which practices are
effective.

## Decision

Experience is kept in assistant task materials, as specified in
[the learning specification](../../../../docs/spec/assistant-task-learning.md)
and [its design](../../../../docs/design/assistant-task-learning.md):

- `outcome` records judge earlier `action` records of the same task
  (migration `098_assistant_task_outcomes.sql`) and are exposed through REST
  and `daynight assistant-task record add --kind outcome`.
- Items record their current open time and append a closure record on every
  close (migration `101_assistant_task_item_lifecycle.sql`); items that existed
  before the migration have no trustworthy open time and are excluded from
  average resolution time.
- `retrospective` events are generated when an item closes and, lazily during
  event pulls, at most weekly when new outcomes exist
  (migration `102_assistant_task_retrospectives.sql`).
- Appendix entries carry an applicability scope and outcome-backed success and
  failure counts (migration `104_assistant_task_appendix_validations.sql`).
- A bounded related-experience query feeds Worker event notifications with
  short summaries, within a fixed request and time budget per batch.
- A 30-day metrics read (migration `103_assistant_task_metrics.sql`) summarizes
  actions, outcomes, escalations, resolution time and recurrence, and the Web
  task page displays it.

Promotion to executable rules stays with the existing proposal flow decided by
the user.

## Alternatives

**Mutable outcome fields on action records.** Records are append-only so that
history and replay fingerprints stay exact. A separate `outcome` record keeps
that guarantee and lets later observations coexist with earlier ones.

**A server scheduler for periodic retrospectives.** The assistant task server
deliberately has no scheduling loop; inquiry timeouts are evaluated during
reads and event pulls. Generating periodic retrospectives the same way avoids
a new lifecycle component at the cost of no retrospective while nothing pulls
events.

**Relying on Session memory or provider-side memory.** Session history is
bounded and replaced on takeover, and provider memory is per machine and
invisible to the user. Task materials survive takeover and are reviewable.

**Automatically promoting validated experience to rules.** Rules can widen
direct actions, which the assistant task specification reserves for user
decisions.

**Deriving resolution time from item `created_at` and `updated_at`.** Items can
be created closed, reopened and edited after closing, so those timestamps do
not identify an open period. Recording transition times and closure records
gives an authoritative source at the cost of no history for pre-existing
items.

## Consequences

- A replaced holder Bot reads the accumulated experience and its evidence from
  task materials without access to the previous Session.
- Outcome judgments are made by the assistant itself and can be wrong; the
  user reviews them through records, appendices and proposals.
- Retrospectives cost assistant turns; the weekly bound and the requirement of
  new outcomes limit them, and no periodic retrospective is generated while
  nothing pulls events.
- Relevance scoring is coarse; it ranks by declared scope and recency rather
  than content similarity.
- Appendix scope categories are limited to 200 bytes while item categories
  have no byte limit, so a longer item category cannot be named in a scope.
