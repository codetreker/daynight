# Agent Note: CI Gate Simplification

Status: implemented

## Problem

The package-version policy is evaluated on a PR before its release inputs reach
main. Repeating that policy after merging adds a second version decision to
mainline application validation. The terminal CI gate also duplicates module
selection when it derives expected job states from flags that the routing job
has already calculated.

## Decision

The [checks workflow](../../../../.github/workflows/checks.yml) runs the
package-version step only for `pull_request` events on the Ubuntu CLI job. It
passes the PR event's base and head commits directly to the existing version
script. Main pushes retain every application suite. The local script keeps its
push comparison mode, including initial-push baseline validation.

Module detection selects complete PR job families and every module on main
pushes. The final `checks` job runs with `always()` after routing and all
application jobs. Its single step uses `jq` to accept only `success` or `skipped`
from every preceding job. Failure, cancellation and any other result fail the
gate. It reads job results without comparing module-selection flags and needs no
checkout, runtime setup or repository helper. The selection-aware result helper,
its CLI path and dedicated tests are removed; routing tests remain in the
lightweight job.

At the time of this decision, the main ruleset required no named check context,
and npm publication consumed a successful whole `checks.yml` main-push run at
the exact source commit. Those consumers needed no configuration or publication
change for this simplification. The later
[CLI publication-validation decision](../process/2026-10-22-cli-publication-validation.md)
replaces the publication dependency with independent CLI validation.

This partially supersedes the
[CLI toolchain decision](../../archived/process/2026-10-16-typescript-cli-toolchain.md), which
originally checked versions on both PR and push events, and the
[module-scoped CI decision](../process/2026-10-21-module-scoped-pr-ci.md), which
originally added selection-aware result aggregation. Their release-input policy,
module routing, native validation and complete acceptance workloads remain.

## Alternatives

**Keep version enforcement on main pushes.** This repeats the version policy
already applied to the reviewed PR. Mainline validation still runs all application
suites without making the release-number decision again.

**Keep selection-aware result validation.** It originally distinguished intentional
skips from unexpected skips by comparing every result with module-selection
flags. The routing job already owns module selection. Reading each preceding
job's result is sufficient for the terminal gate to reject failed or cancelled
work without another selection calculation and repository helper.

## Consequences

Version failures remain visible in the PR's Linux CLI job and fail the final gate.
Main-push runs provide full application evidence without repeating the PR version
policy. Documentation-only PRs run routing tests
and the final gate while application jobs are skipped. Job selection, coverage
thresholds, real-service acceptance and cleanup requirements are unchanged.

The final `checks` result summarizes whether every preceding job succeeded or
was skipped. It does not validate selected-versus-skipped job combinations.
