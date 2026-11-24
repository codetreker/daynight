# Agent Note: Go PR Coverage Profile Normalization

Status: implemented

## Problem

Cross-package coverage produces many repeated atomic blocks. Each coverage
consumer scans the entire profile and CI compresses and uploads it, even though
the number of unique blocks is much smaller. The complete production denominator,
execution counts, failure evidence and existing coverage gates remain necessary.

## Decision

The PR module capture builds and tests a normalizer, then runs it after a
successful Go test closes and before go-cov reads the profile. It sums counts
only for matching file and source ranges with consistent statement counts.
It rejects malformed input and unsupported count overflow, writes a candidate
in the profile directory and replaces the original only after validation.
Capture failure prevents a successful check and retains the raw test stream.
Local, main and startup/shutdown coverage keep their existing behavior.

## Alternatives

**Keep the duplicate profile.** This avoids a new transformation, but every
report and the artifact upload continue to process the repeated blocks.

**Reduce the coverage package universe.** This changes cross-package coverage
and its denominator, weakening the gates rather than removing duplicate work.

## Consequences

The PR job spends time building and testing the normalizer and processing the
profile once. Subsequent consumers and artifact upload handle fewer rows. The
normalizer and its failure behavior must remain compatible with the pinned
go-cov and Go coverage format. The [module throughput decision](2026-11-24-go-module-ci-throughput.md)
retains the single complete module invocation and its vet and resource boundaries.
