# Agent Note: Server CI Input Selection

Status: implemented

## Problem

Go coverage and E2E install the CLI to exercise authentication, project and task
operations, and deadline behavior. Selecting both jobs for every CLI source
change makes independent worker prompts and bundled skills pay for server
validation. A release-only version change also selects those jobs even though
the installed version and the fixture's expected version advance together.
Those extra runs increase PR validation work without exercising the changed
behavior. Removing every CLI dependency would miss changes to the commands and
shared code that server acceptance actually uses.

## Decision

The [selector](../../../../.github/scripts/ci-modules.mts) follows the existing
CLI command-loading boundary. Implementations and resources under
`commands/worker/`, `controller/`, `review/`, `skill/`, `update/` and `completion/`
select CLI validation without selecting server jobs. Each command's
`definition.ts` remains a server input: the CLI registry imports definitions at
startup, then loads only the selected command's implementation. All other CLI
source remains a conservative server input, including startup, shared code and
project/task/authentication command code. Existing API, Session and text inputs
retain their Web selection, and embedded Web, build, acceptance and fixture
inputs retain their server consumers.

Modified CLI manifests are compared as parsed JSON objects from the PR's
merge-base and explicit head, with only top-level `version` removed. Equality
omits server jobs. Formatting and object key order do not affect equality;
other fields, nested versions and array order do. Manifest additions, deletions
and file-type changes select server jobs. Malformed modified manifests and Git
read failures fail detection. Root manifests, lockfile and workspace inputs keep
all-module selection. This decision originally retained the complete CLI suite
for equality; the [version-only PR decision](2026-11-04-version-only-pr-ci.md)
partially supersedes that choice by skipping application checks for a strict
whole-PR version-only diff. Other manifest changes retain ordinary CLI selection.

This decision partially supersedes the broad CLI routing adopted for the
[independent coverage and E2E jobs](2026-11-04-server-e2e-ci-jobs.md). The jobs
continue to share one server selector and retain their independent fixtures,
complete tests, coverage thresholds, deadlines and final gate. The
[README routing table](../../../../README.md#ci-selection) owns current path
selection, and the [development guide](../../../../docs/development.md#ci-selection)
owns comparison and execution details.

## Alternatives

**Select server jobs for all CLI source and manifests.** Both jobs prepare the
whole CLI package, so this avoids maintaining command ownership. It also reruns
all server validation for runtime code that the selected acceptance commands do
not load, bundled instruction text and release-only metadata.

**Derive a complete TypeScript import graph.** Automatic reachability could
track new shared dependencies without manually assigning them. The detection
job currently needs only Node, before dependency installation. A sound graph
would need TypeScript syntax parsing, startup and command-specific dynamic import
semantics, runtime resources and both revisions for deleted or moved paths. The
existing lazy-loading boundary gives a smaller explicit rule for this problem.

**Split installed-CLI acceptance into another gate.** That could separate
cross-client changes from production Go coverage, but authentication assertions
contribute to production coverage and produce credentials for deadline probes.
Moving them would change validation and resource ownership. Narrow routing can
remove the unrelated work while preserving that ownership; a future split must
reconsider coverage and credential production together.

## Consequences

Independent command changes retain complete CLI checks while avoiding unrelated
Go coverage and E2E. A strict version-only PR skips application checks as owned
by the later decision. Real server acceptance dependencies, unknown CLI source,
deletions, renames and unclassified inputs keep conservative selection. Main pushes still select every module, and the final gate still
rejects failed or cancelled selected jobs.

The explicit command exclusions depend on implementation modules remaining lazy
and outside the server acceptance call graph. Moving code into startup or shared
imports, adding an eager definition dependency, or extending acceptance to an
excluded command requires updating the selector and its behavioral tests with
that change. Keeping routing in one dependency-free selector leaves import-graph
analysis or a separate acceptance gate possible without changing the current
job contracts; neither mechanism is required by these exclusions.
