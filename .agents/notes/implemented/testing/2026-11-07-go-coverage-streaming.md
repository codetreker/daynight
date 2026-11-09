# Agent Note: Go Coverage Streaming and Race Policy

Status: implemented

## Problem

Cross-package Go coverage produces large profiles, especially with race instrumentation. A whole-profile string can exceed Node's string size limit before the strict total coverage comparison runs. Mainline validation also needs race instrumentation while PR validation must remain bounded by its separate race policy.

## Decision

The coverage comparator reads profile rows incrementally, validates and deduplicates blocks, and compares unrounded statement counts against the same strict threshold. Local and main CI checks use race instrumentation; PR CI explicitly disables it, including an inherited race flag. The [coverage boundary decision](2026-11-06-go-module-coverage-boundary.md) records the package selection and earlier CI policy.

## Alternatives

**Read the entire profile as a string.** This fails before evaluating coverage when the profile exceeds the runtime's string limit.

**Disable race or exclude packages to shrink the profile.** Either changes the validation evidence and weakens the required check. Incremental reading preserves the existing coverage universe and comparison.

## Consequences

Memory grows with distinct coverage blocks instead of the full profile size. The check continues to reject malformed rows, inconsistent duplicates and totals at or below 90%. Mainline race validation costs more time and resources than the former uninstrumented main CI run.
