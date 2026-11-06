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
use that output rather than rereading the repository variable. Each consumer
validates the input before dependency installation or candidate execution.

The trust root is `image-test-pairs.json` at the exact commit named by the
repository Actions variable `DAYNIGHT_IMAGE_TEST_PAIRS_COMMIT`. The commit must
belong to the protected `refs/heads/ci/image-test-pairs` history. Its active rules
must restrict updates and prevent deletion and non-fast-forward changes. Only
authorized CI maintainers may publish manifests or update the variable. Repository
configuration must restrict their writer identities separately from ordinary PR
authors; a JSON record cannot grant that authority. Jobs have read permissions
only, do not persist checkout credentials, and expose the API token only to the
validator step.

An initial manifest contains `{"schemaVersion":1,"pairs":[]}`. Missing or
unreadable configuration fails the check; an empty, verified manifest runs the
ordinary checkout. Provisioning this empty protected input is required before
the first facility PR can pass hosted CI. The facility's own tests use isolated
Git repositories and do not require a pairing registration for themselves.

Each pair has the following fields:

| Field | Meaning |
| --- | --- |
| `base` | Full common prerequisite commit SHA |
| `implementation` | `{pr, sha, reviews}` for the exact implementation candidate |
| `tests` | `{pr, sha, reviews}` for the exact test candidate |
| `productionTree` | Git tree after removing the exact allowed test paths |
| `allowPaths` | Exact allowed test or fixture paths; no globs |

`reviews` contains GitHub review IDs. Unknown fields, malformed identities,
conflicting records, stale candidate heads, missing or revoked approvals and
incompatible ancestry fail. Approvals must cover the candidate SHA and come from
identities independent of both PR authors. Semantic test review remains necessary:
path and diff validation cannot prove that a new assertion tests the intended
behavior.

A temporary Git index composes the test input and verifies that removing the
allowed paths yields the implementation's recorded production tree. The
checkout's production files remain unchanged. When additional tests are needed,
a deterministic local commit records the combined tree with the original checkout
as its parent. The original clean-checkout checks therefore observe the real
combined commit and tree; evidence retains the original checkout and I/T
identities. Browser acceptance and shard aggregation receive this combined
commit as their child process `GITHUB_SHA`; their existing clean-source assertions
remain enforced. Pair evidence retains the actual event head and checkout commit
so the combined run cannot be confused with a run of the original event tree.
This local commit is never pushed. The same comparison
accepts an implementation merged by squash while its test PR remains open; a
concurrent production change cannot reuse that record. Deletions, symlinks,
gitlinks, production files, dependency inputs, workflows and coverage configuration
are refused as test overlays. Existing tests cannot lose lines through the
pairing input.

A nonempty manifest is an explicit coordination interval. Unmatched PRs or
production trees fail instead of silently falling back to ordinary tests. After
the test PR merges, retain its record until normal main validation succeeds with
the tests already present. An authorized maintainer can then remove the mapping
and publish a new pinned manifest. Any candidate or production change requires
fresh registration, applicable review and checks.

Each job records the manifest, base, candidate SHAs, current source, combined commit and
production trees in `.tmp/image-test-pairs.json`. Existing test runners remain
the owners of test counts and coverage. These identities bind their artifacts to
the supplied input; local fixtures do not prove hosted PR or main execution.

## Alternatives

**Run a supplemental combined check.** This leaves the original required checks
on a different input and cannot establish that their compilation and coverage
requirements passed. Supplying the verified overlay to the existing jobs keeps
those gates authoritative.

**Read the test PR's current branch directly.** A branch can advance after review
or between jobs. A protected manifest pins candidate commits and review objects,
and the workflow passes one immutable manifest commit to all consumers.

**Treat missing configuration as no pairing.** A missing or inaccessible mapping
would run incomplete tests without exposing the failure. An explicitly verified
empty manifest makes ordinary operation distinguishable from missing input.

## Consequences

Independent implementation and test PRs can share exact reviewed tests without
moving product changes into the test PR or reducing validation. The main merge
window uses the same input and rejects production drift.

This adds a maintainer-operated configuration boundary and temporarily serializes
work covered by an active manifest. Provisioning, actual I/T PR execution, the
main merge window and final ordinary main success require separate observed
results. The facility does not assert that image behavior, native Providers or
any product acceptance has passed.
