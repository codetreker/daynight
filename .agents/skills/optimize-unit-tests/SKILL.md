---
name: optimize-unit-tests
description: Diagnose and reduce existing unit-test runtime, resource use, and contribution to CI completion time while preserving defect detection. Use when asked to investigate or optimize slow or resource-heavy unit tests or suites.
---

# Optimize Unit Tests

Reduce the cost of obtaining the same meaningful test signal. Consider both local
feedback and overall CI completion time.

## Establish scope

Read the requested tests, their helpers, runner configuration, relevant CI
workflow, and project validation requirements. Identify what behavior and real
boundaries the tests prove; filenames alone do not establish test isolation.

Respect diagnosis-only requests and the authorized edit scope. Evaluate test,
helper, runner, CI, and production changes against that scope. Preserve required
test selection, quality gates, and product behavior.

## Measure and prioritize

- Define the target metrics and their boundaries: case, file, suite, command, job,
  overall CI completion time, and relevant CPU, memory, or I/O costs. Distinguish
  elapsed time from accumulated execution time.
- Use representative existing CI records when available. Inspect job dependencies,
  parallel execution, long-running steps, and test-duration distributions.
  Identify the critical path and unusually long jobs, steps, files, or cases.
  These outliers must receive priority analysis, even outside the critical path.
- Rank supported opportunities by absolute cost, impact on CI completion,
  execution frequency, and resource use. Distinguish queueing and runner
  allocation from build, discovery, transformation, setup, test body, assertion,
  waiting, instrumentation, and teardown costs.
- Establish a comparable baseline before changing code. Use focused profiling
  when existing reports cannot explain the cost. Record relevant versions,
  commands, environment, worker settings, instrumentation, cache state, failures,
  and variation. Ensure measured tests actually execute.
- When CI records or resource measurements are unavailable, state the limitation
  and use the evidence available. Keep projected CI impact separate from observed
  CI improvement.

## Reproduce CI resource limits

When optimizing or debugging CI cases, run the local baseline and validation in
Docker with explicit CPU and memory limits. Match the target CI budget when
known; otherwise choose and disclose a representative budget, for example
`--cpus=2 --memory=4g --memory-swap=4g` for a two-CPU quota, 4 GiB RAM, and no swap.
Verify that the limits are enforced and record the actual test worker count.

Use the relevant CI toolchain, dependencies, instrumentation, test selection,
and suite concurrency. Compare both revisions under the same resource budget;
identify intentional optimization variables separately. Record the image,
platform, Docker backend, and mount strategy. Report constrained-container
measurements separately from observed CI results and retain required native
platform validation. Unavailable Docker execution or unenforced limits leave a
validation gap.

Track Docker resources created or acquired for the task from setup onward.
Arrange automatic removal
and cleanup on success, failure, and interruption. After saving required evidence,
remove task-owned containers, including stopped ones, networks, volumes,
images, and build caches. Preserve pre-existing or shared resources.
Reconcile leftovers after interrupted runs and inspect Docker after cleanup to
verify that no task-owned resources remain. Verified cleanup is a completion
condition; report unresolved cleanup as incomplete.

## Optimize while preserving the proof

For each candidate, identify the behavior being proved, the measured expensive
mechanism, and why the replacement should still reject the relevant incorrect
behavior.

Choose techniques from the actual bottleneck. Cheaper equivalent comparisons,
scoped queries, reusable immutable setup, explicit synchronization, controlled
time, and concurrency changes are possibilities, not universal prescriptions.

Inspect long sleeps in tests and long polling, retry, or periodic intervals in
the exercised code. Replace fixed readiness sleeps with explicit synchronization.
When elapsed time is incidental, mock intended intervals to shorter test-local
durations or control the clock. Preserve asynchronous yielding, cancellation,
ordering, and cleanup; an immediately resolved promise may erase these semantics.
Keep production timing defaults intact and verify configured durations or timeout
boundaries separately when they are part of the contract.

Preserve these constraints:

- Retain meaningful scenarios, boundary inputs, error paths, ordering,
  cancellation, isolation, and cleanup. Smaller datasets must still cross the
  thresholds or exercise the scale-dependent behavior the test protects.
- Equivalent assertions may be reorganized or replaced. Assertion count, test
  count, and coverage percentage alone do not prove preserved defect detection.
- Do not count skipped tests, narrower discovery, weaker assertions, relaxed
  deadlines, added retries, or reduced required checks as optimization gains.
- Reuse mutable fixtures or change isolation and concurrency only with evidence
  that state, ownership, teardown, and background work remain isolated.
- Mocks must not replace the mechanism being verified. Advancing a clock or
  shortening an interval does not prove that real I/O or unrelated work completed.
- Classify a workload before moving it between suites. Preserve necessary
  functional and boundary regressions, and follow project policies for separate
  capacity or stress testing.
- Diagnose failures from their evidence. Repeated passes do not establish the
  cause of an intermittent failure. Follow applicable retry limits and policies.

## Verify the result

Run the changed tests and the applicable surrounding validation gates. Check the
behavior exercised, failure paths, state isolation, and resource cleanup.

When changes to mocks, timing, shared fixtures, or assertion boundaries warrant
stronger evidence, use targeted fault injection within the permitted edit scope.
Apply the same representative fault to the original and optimized tests: both
must fail for the expected behavior violation. An unrelated fixture exception is
not proof. Restore temporary mutations and remove profiling artifacts.

Compare before and after with non-target factors held steady. Allow the factor
being optimized, such as worker count or fixture organization, to change and
identify it explicitly. Preserve required instrumentation and gates in acceptance
runs; label diagnostic runs separately. Distinguish build caches from cached test
results, and verify actual execution when measuring test work.

Repeat measurements enough to distinguish the effect from noise, proportional to
run cost and observed variation. Report the sample count, a representative value,
and spread. Measure relevant resource trade-offs, especially when adding workers
or sharing setup.

## Report and finish

Report:

- The measured bottleneck, changes made, and why the test's proof remains valid.
- Comparable before/after metrics, conditions, and relevant validation results.
- Local savings, observed job or overall CI savings, and estimated CI impact as
  separate claims. Local speedups do not establish overall CI improvement.
- Resource trade-offs, remaining significant costs, and evidence limitations.
- Confirmation of Docker cleanup when containers were used.

Finish after required validation and cleanup, when the requested improvement is
verified or evidence supports that no worthwhile safe optimization remains within
scope. Respect explicit targets; otherwise do not invent a fixed speedup
percentage or pursue unrelated tuning.
