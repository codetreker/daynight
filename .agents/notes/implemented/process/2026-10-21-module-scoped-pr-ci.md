# Agent Note: Module-Scoped Pull Request CI

Status: implemented

## Problem

Unrelated module validation makes a PR wait for native CLI, shell completion,
Go/PostgreSQL and browser/container suites even when its changed files affect
only one module. Documentation maintenance also pays the full application-test
cost. Reducing that work must preserve meaningful module validation and make a
failed selection step distinguishable from an intentional skip.

## Decision

The [checks workflow](../../../../.github/workflows/checks.yml) starts with a
lightweight, dependency-free Node.js routing job. PR selection compares the
explicit event head with the merge base of the event base and head. Full Git
history and `git diff --name-only -z --no-renames` preserve deleted paths,
cross-module moves and unusual filenames without a changed-file API limit.
Application jobs continue testing the checked-out PR merge result. The
[README routing table](../../../../README.md#ci-selection) owns the exact paths.

Each module keeps its complete job: the CLI selects all three native platforms
and shell completion; Go selects server validation; web selects web validation.
Multiple changed modules select their union. Shared workspace/dependency inputs
select all consumers. The shared installed-CLI fixture selects CLI, Go and Web
because all three consume its packed package and receipt contract. The
[attachment acceptance decision](../testing/2026-10-21-task-attachment-cross-layer-acceptance.md)
records the new Web consumer. Known web dependency patches select web; unclassified
inputs select every module until their ownership is explicit. All CLI source
paths select CLI validation before documentation exclusions, preserving the
existing release-input policy and recursive runtime-skill packaging. Repository
docs and workflow guidance otherwise skip application tests. The exact root
`.gitignore` also skips application tests: repository-local metadata ignores
such as `/.daynight/` do not change tracked application inputs. Nested ignore
files retain their module ownership or the unclassified-path fallback, and
exclusions do not suppress jobs selected by other changed paths.

The Go job retains real web builds and installed-CLI acceptance. The web job
retains production Go builds, browser and deployment acceptance. Module selection
changes job scheduling without separating or weakening these integration suites.
Every main push runs all jobs. This originally also supplied the exact-commit
main run required by npm publication. The
[CLI publication-validation decision](2026-10-22-cli-publication-validation.md)
removes that release dependency while retaining full main-push validation.

The workflow starts on every PR, including changes only to documentation or the
root `.gitignore`. Routing tests run in the lightweight job without installing
pnpm dependencies. The final
`checks` job runs after every routing and application job and accepts only success
or skipped for each result. Failures, cancellations and other results fail the
gate. Intentionally unselected jobs remain skipped.

This scheduling decision originally included a final `checks` job that validated
selection flags and required success for selected jobs and skipped for unselected
jobs. It distinguished intentional omissions from unexpected skips, selection
failures and missing outputs. The later
[CI simplification decision](../simplification/2026-10-21-ci-gate-simplification.md)
replaces selection-aware aggregation with the job-result gate and keeps
package-version enforcement in PRs. The path selection and each module's
validation workload remain unchanged.

This refines the scheduling described by the
[CLI toolchain decision](../../archived/process/2026-10-16-typescript-cli-toolchain.md),
[server foundation](../../archived/architecture/2026-10-19-server-runtime-foundation.md) and
[dashboard acceptance decision](../testing/2026-10-20-dashboard-production-acceptance.md).
Their module workloads and acceptance criteria continue to apply when selected.
GitHub's [job-condition documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions)
and [dependency documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds)
define routing dependencies and the skipped state of unselected jobs.

## Alternatives

**Filter the entire workflow by changed paths.** At the time of this decision,
this prevented the workflow from producing the planned final check on excluded
PRs. GitHub's
[path-filter documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore)
explains that skipped workflows can leave required checks pending. Job-level
selection also keeps routing tests active for documentation-only PRs.

**Allow every skipped dependency in the original aggregate.** This could not
distinguish an intended omission from a selected job skipped because routing or
a dependency failed. The original selection-aware aggregate preserved that
distinction; the later simplification accepts success or skipped from every
preceding job without comparing selection flags.

**Run every module on every PR.** This was the existing scheduling behavior and
provided broad integration evidence before each merge. It spends the full
native/browser/database workload on unrelated source and documentation changes.
Whole-module PR checks and full main validation retain the existing test suites
while removing that repeated work.

## Consequences

Module-only PRs wait for their own job family and the final gate. PRs changing
only documentation or the root `.gitignore` run routing tests and the gate. Every
selected suite retains its original coverage, real-process behavior, time bounds and cleanup
failures. No repository protection changes or additional workflow permissions are
required.

The path map is maintained alongside package and tooling ownership. Unknown
paths deliberately incur full validation, so a new package or dependency patch
cannot silently lose verification. Mainline full validation can discover a
cross-module regression after a module-only PR merges; broad pre-merge evidence
requires changing the routing policy or explicitly selecting the affected paths.
The existing integration inside module jobs reduces that gap without claiming
that each PR executes every consumer's acceptance suite.
