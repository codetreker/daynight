# Agent Note: Validate the Checked-Out CI Source

Status: implemented

## Problem

A CI run needs a clear relationship between the source it checks out and the
compilation, tests, coverage and artifacts it reports. The fixed implementation
and test-pair registry made ordinary jobs depend on other PR heads, approvals
and a shared production-tree window before those jobs could execute. Unrelated
source changes could therefore fail global input validation without obtaining
results from their actual checkout.

## Decision

The checks workflow selects modules from the complete PR diff and runs their
normal validation against the job's ordinary event checkout. Detection compares
the explicit PR head with its merge base using complete history and NUL-delimited
paths; both sides of renames and deletions remain inputs. Main pushes retain the
existing full-module selection.

The global image-test-pairs registry, validator and tests are removed. Jobs do
not fetch another test PR as an executable overlay, create a test-composition
commit, publish pairing receipts or require a cross-job pairing gate. The source
and artifact receipts owned by individual validation runners continue to identify
the code and products they actually validate.

Suite commands, platform matrices, coverage thresholds, selected-job failure
semantics and owned-resource cleanup retain their existing owners. Compiler,
assertion and coverage failures remain visible on the checked-out source.
Separate implementation and test PRs must each satisfy the normal checks of
their actual validation checkout; a supplemental combined result cannot replace
those required checks.

This decision supersedes the [fixed-image test-input decision](../../archived/testing/2026-11-06-fixed-image-test-pairs.md).
The predecessor is archived with its original bytes and historical reasoning.

## Alternatives

**Retain the registry and repair its active input window.** This preserves the
previous model for independently reviewed implementation and test candidates,
but requires coordinated candidate and registry revisions and keeps ordinary
validation dependent on that external input state. It does not simplify the
relationship between an event checkout and its required results.

## Consequences

A required result describes the ordinary source checked out by that job. Module
selection remains diff-driven, and missing compilation, test or coverage proof
is exposed by the normal gates. The workflow no longer coordinates a global
implementation-to-test merge interval.

Local fixtures and documented suite-specific resource overlays remain inputs
owned by their runners; they do not supply test code from another PR. Product
image features and generic source-bound acceptance records retain their own
requirements. Historical pairing receipts describe historical runs, not current
CI inputs or approval.
