# Plan and Run an Investigation

Use this method with a topic skill. The topic skill names the conditions,
measurements and judgments that matter; this reference keeps the shared cycle,
the coverage record and classification.

## Start from user goals

Choose representative goals that answer real questions: find a pending task,
understand why it cannot run, continue an assistant conversation, finish a
workflow quickly, or see how another product supports the same job. Include the
actions before and after a suspicious step; an isolated observation can miss a
navigation, state-preservation or latency problem.

Work through this cycle:

1. Observe the ordinary path and establish its expected outcome from the
   specification, documented behavior or the user's stated goal.
2. Vary content, conditions, state or input in ways that real use permits.
3. Record a candidate with the affected action and a minimal reproduction.
4. Reproduce it and collect evidence under [the evidence standard](evidence.md).
   Inspect the relevant source before claiming a cause.
5. Classify it. Keep an unconfirmed candidate distinct from a finding.
6. Package and dispatch each confirmed improvement separately.

## Record coverage

Keep a small coverage table in the worktree's ignored `.tmp/`. It describes what
was exercised; it is not a task or a work log. Add a row when exploration finds
another meaningful path, not for every action.

| User goal and route | Fixture/state | Conditions | Interventions | Evidence | Judgment or gap |
| --- | --- | --- | --- | --- | --- |

Conditions are topic-specific: viewport, locale and input for a UI audit; data
size, concurrency and build mode for performance; product, plan and date for a
competitor comparison. Cover the cells the topic skill selects, and explicitly
record skipped or unavailable ones. Do not create a cross-product of every cell.
Challenge the user goal, expand around a discovered failure and state the
coverage limit.

Do not induce a shared service outage or alter an unrelated Worker merely to fill
an error-state row. Label intercepted responses, mocked states and simulated
loads; they cannot establish that the real system produced that state.

## Classify by impact

| Observation | Treatment |
| --- | --- |
| Routine use causes an unintended action, loses work, exposes data or makes an essential action unreachable | Prioritize it as an independent defect and verify preservation and recovery behavior |
| Common use is noticeably harder, slower or more confusing than necessary | Prepare a bounded improvement with measurable acceptance |
| A deliberate, specified behavior works as specified | Exclude it with the reason; propose a behavior change only within the user's scope |
| The failure also occurs without Daynight, such as a browser, account or automation failure | Diagnose the environment and report that layer unverified; do not assign a product defect |
| The same problem already has an owner, or a delivered change already resolves it | Reuse or exclude under [the handoff procedure](handoff.md#choose-an-independent-owner); a new screenshot alone does not justify another task |
| A preference without a specific user cost, or a source-only suspicion | Retain as a candidate or exclude it; do not manufacture a repair task |

## Improve the method after each run

Record paths exercised, findings, exclusions and untested layers in the private
record. For an exclusion, save the reason that changed the judgment: expected
state, duplicate, already fixed, stale artifact, incomplete capture or platform
failure. A finding count is not an effectiveness measure.

When a fix is delivered and retesting is in scope, identify the delivered
revision and running build, replay the original failure, then check adjacent
states with equivalent evidence. A task marked done, a passing unit test or a
prototype cannot replace this product check.

A user correction during a run is evidence about the method. When the user has to
ask for a missing condition, kind of finding or level of design, add that
expectation to the topic skill so later runs include it without prompting.

Keep concrete task evidence in the owning tasks. Improve the topic skill with
reusable decisions, reliable fixture recipes and verified failure diagnostics;
change this contract only for lessons shared by every topic. Do not accumulate
private IDs, process logs or audit chronology in skills. Script repeated,
error-prone mechanics; keep judgment about user impact, scope and expected
behavior explicit.
