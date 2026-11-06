# Agent Note: Fixed Image Test Inputs for Independent Pull Requests

Status: implemented

## Problem

An implementation PR may introduce APIs whose meaningful tests belong to a
separate test PR. Running either tree alone can fail compilation or the existing
coverage gate. A supplemental passing check does not establish that the required
checks exercised the implementation with its intended tests. During the interval
between implementation and test merges, main has the same need for an exact,
reviewed test input.

## Decision

The [pair validator](../../../../.github/scripts/image-test-pairs.mts) supplies
verified test files to the original [checks workflow](../../../../.github/workflows/checks.yml).
Job names, module selection, validation commands and thresholds retain their
existing owners. The module-selection job locks one manifest commit; consumers
use that output. Each consumer validates the input before dependency installation
or candidate execution.

The registry is `.github/scripts/image-test-pairs.json` on main. Its publication
uses the existing required independent approval and `checks`, with stale-approval
dismissal, resolved review threads, deletion protection and non-fast-forward
protection. Missing rules or unreadable input fail validation. No additional
repository permissions, rulesets, dedicated refs or Actions variables are needed.
Registry modifications use ordinary reviewed PRs. A registry change in an
unmerged PR is validated but never supplies executable test input.

An initial registry contains `{"schemaVersion":1,"pairs":[]}`. It is delivered
separately under the ordinary checks before the reader is enabled. This avoids
a bootstrap dependency without treating a missing registry as an empty one.

For a PR, detection reads main once and pins the exact registry commit. For a
main push, it uses that push's commit and verifies that it belongs to protected
main history. This retains the correct input for an earlier queued main run
after a later run removes a completed mapping. All jobs consume the same pin.

Each pair has the following fields:

| Field | Meaning |
| --- | --- |
| `base` | Full common prerequisite commit SHA |
| `implementation` | `{pr, sha, reviews}` for the exact implementation candidate |
| `tests` | `{pr, sha, reviews}` for the exact test candidate |
| `productionTree` | Git tree after removing the registry and exact allowed test paths |
| `allowPaths` | Exact allowed test or fixture paths; no globs |

`reviews` contains GitHub review IDs. Unknown fields, malformed identities,
conflicting records, stale candidate heads, missing or revoked approvals and
incompatible ancestry fail. Approvals must cover the candidate SHA and come from
identities independent of both PR authors. The test PR's actual merge-base diff
must also contain only its allowed tests. Semantic test review remains necessary:
path and diff validation cannot prove that an assertion tests the intended
behavior.

The registry's fixed path alone is excluded from production-tree comparison,
besides the explicit test paths. Registering a candidate therefore does not change
its production identity or require a commit to contain its own registration SHA.
Production files, dependencies, workflows and coverage configuration cannot be
supplied as test overlays. Deletions, symlinks, gitlinks and removed existing test
lines are refused.

The validator uses actual GitHub squash merge commits and Git ancestry to decide
whether the tested checkout contains I and T. Before I is incorporated, ordinary
and registry PRs run their original checks. A registered I/T PR always validates
its exact pair. Once I is incorporated while T is absent, the checkout must match
one valid registered production tree and use that pair's tests. After T is
incorporated, the checkout runs ordinary checks without an overlay. `merged=true`
alone cannot establish that an earlier checkout contains a change.

Registry updates cannot remove a mapping until its T merge is incorporated,
including when I has not merged yet. PR validation checks the proposed registry
against its trusted main input. A main push also checks the transition from its
first parent against the event commit, so a stale successful registration check
or a later T merge cannot authorize an earlier untested main revision. During
an active I-to-T interval, keep the registered T head immutable. To revise it,
prepare and independently review a replacement candidate PR, then submit a
registry-only replacement whose checks still consume the valid old input. Retire the old candidate after the
replacement registry is merged. Updating the old T first would invalidate the
only trusted input needed to validate its replacement. Remove the final mapping
only after T is incorporated and ordinary main validation has passed.

Cancelling an unmerged I retains its registration: a closed PR can be reopened,
so deletion could lose its required input. Unchanged trusted records do not need
candidate revalidation during unrelated registry updates. New or changed records
are validated, and a selected pair always receives full validation, including
after a candidate is reopened. Retained cancelled records count toward the
100-pair limit; exceeding that limit fails explicitly.

A temporary Git index composes the tests and verifies the recorded production
tree. Raw reviewed blobs are written atomically and checked byte for byte. Local
Git operations receive no API token and disable filters and hooks. Immutable Git
fetches use a separate read-only credential environment without persistence.
Jobs expose the API token only to validation, not to later candidate execution.

When additional tests are needed, a deterministic local commit records the
combined tree with the original checkout as its parent. Production bytes and the
original branch remain unchanged. The local commit is never pushed. Browser
acceptance and shard aggregation receive the combined commit as their child
process `GITHUB_SHA`; existing clean-source assertions remain enforced. Evidence
retains the actual event head, original checkout, manifest, I/T/base, combined
commit/tree and production tree in `.tmp/image-test-pairs.json`. Runtime consumers
and the final gate compare these identities across all selected jobs. Existing
test runners retain ownership of test counts and coverage.

## Alternatives

**Run a supplemental combined check.** This leaves the original required checks
on a different input and cannot establish that their compilation and coverage
requirements passed. Supplying the verified overlay to the existing jobs keeps
those gates authoritative.

**Use a dedicated protected ref and Actions variable.** The initial design
required separately administered publication of both resources. That would add a
configuration dependency outside the existing repository write permissions.
Publishing the registry through main reuses its existing independent approval
and required checks, at the cost of an additional reviewed registration PR.

**Read the test PR's current branch directly.** A branch can advance after review
or between jobs. Registry entries pin candidate commits and review objects, and
the workflow passes one immutable registry commit to all consumers.

**Treat missing input as no pairing.** A missing or inaccessible registry would
run incomplete tests without exposing the failure. A separately bootstrapped,
verified empty registry makes ordinary operation distinguishable from missing
input.

## Consequences

Independent implementation and test PRs share exact reviewed tests without moving
product changes into the test PR or reducing validation. The main merge window
uses the same input and rejects production drift.

Registration and active-candidate replacement require additional reviewed PRs.
The immutable candidate sequence prevents the registry's own checks from losing
their trusted input. Actual I/T PR execution, the main merge window and final
ordinary main success still require observed results; local Git fixtures do not
prove hosted CI, image behavior or native Provider acceptance.
