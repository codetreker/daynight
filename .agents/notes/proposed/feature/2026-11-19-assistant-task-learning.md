# Agent Note: Assistant Task Outcome-Based Learning

Status: proposed

## Problem

Assistants that repeatedly handle the same kind of item do not get better at
it. What an assistant learns lives in its Session context, which is compacted,
evicted from the bounded Session cache, or replaced when another Bot takes
over the task. Existing work records say what was done but not whether it
worked, so neither the assistant nor the user can tell which practices are
effective.

## Proposal

Keep experience in assistant task materials, as specified in
[the learning specification](../../../../docs/spec/assistant-task-learning.md)
and [its design](../../../../docs/design/assistant-task-learning.md):
`outcome` records judge earlier `action` records; `retrospective` events are
generated when an item closes and, lazily during event pulls, at most weekly
when new outcomes exist; appendix entries gain an applicability scope and
outcome-backed validation counts; a bounded related-experience query feeds
event notifications; and a 30-day metrics read summarizes effectiveness.
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

## Acceptance Criteria

- Outcome records, retrospectives, appendix scope and validation, the
  related-experience query and metrics behave as the specification requires,
  verified by the tests named in the design.
- A replaced holder Bot can read the accumulated experience and its evidence
  without access to the previous Session.

## Risks

- Outcome judgments are made by the assistant itself and can be wrong; the
  user reviews them through records, appendices and proposals.
- Retrospectives cost assistant turns; the weekly bound and the requirement of
  new outcomes limit them.
- Relevance scoring is coarse; it ranks by declared scope and recency rather
  than content similarity.
