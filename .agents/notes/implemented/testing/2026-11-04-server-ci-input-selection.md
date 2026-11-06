# Agent Note: Server CI Input Selection

Status: implemented

## Problem

Go coverage and E2E originally installed the CLI to exercise authentication,
project/task operations and deadlines. Selecting those jobs for every CLI source
change made independent worker prompts and bundled skills pay for server
validation. Release-only version changes also selected them while installed and
expected versions advanced together. Those runs added work without exercising
the changed behavior. At that time, removing every CLI dependency would have
missed the commands and shared code used by installed-client acceptance.

## Decision

The [selector](../../../../.github/scripts/ci-modules.mts) follows the existing
CLI command-loading boundary. Implementations and resources under
`commands/worker/`, `controller/`, `review/`, `skill/`, `update/` and `completion/`
select CLI validation without selecting server jobs. Each command's
`definition.ts` remains a server input: the CLI registry imports definitions at
startup, then loads only the selected command's implementation. All other CLI
source remains a conservative server input, including startup, shared code and
project/task/authentication command code. Existing API, Session and text inputs
retain their Web selection. Web build inputs continue to select Go for embedded
assets; the shared installed-CLI fixture now selects CLI and Web only. Deleted
service/deadline helper inputs no longer have a Go consumer.

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
[independent coverage and E2E jobs](2026-11-04-server-e2e-ci-jobs.md). The [Go module validation boundary](2026-11-06-go-module-validation-boundary.md)
removes the former process job and client installation. The remaining selector
still conservatively selects Go module validation for the listed CLI inputs;
that routing no longer implies CLI execution inside the Go gate. The
[README routing table](../../../../README.md#ci-selection) owns current path
selection, and the [development guide](../../../../docs/development.md#ci-selection)
owns comparison and execution details.

## Alternatives

**Select server jobs for all CLI source and manifests.** At the time both jobs
prepared the whole CLI package. The broad rule avoided maintaining command
ownership but reran validation for unloaded runtime code, bundled instructions
and release-only metadata.

**Derive a complete TypeScript import graph.** Automatic reachability could
track new shared dependencies without manually assigning them. The detection
job currently needs only Node, before dependency installation. A sound graph
would need TypeScript syntax parsing, startup and command-specific dynamic import
semantics, runtime resources and both revisions for deleted or moved paths. The
existing lazy-loading boundary gives a smaller explicit rule for this problem.

**Split installed-CLI acceptance into another gate.** Authentication assertions
then contributed production coverage and generated deadline-probe credentials.
Moving them changed both validation and resources. Narrow routing removed
unrelated work without changing that ownership. The later module boundary
revisits it by assigning client and service assertions to their actual owners.

## Consequences

Independent command changes retain complete CLI checks while avoiding unrelated
Go validation. A strict version-only PR skips application checks as owned
by the later decision. Unknown CLI source, deletions, renames and unclassified
inputs keep conservative selection even after the Go execution boundary changes. Main pushes still select every module, and the final gate still
rejects failed or cancelled selected jobs.

The original exclusions depended on implementations staying lazy and outside
the acceptance call graph. Eager definitions and shared imports required selector
updates with that relationship. The remaining conservative selector is separate
from actual module execution; routing and its tests must change together when
its declared input ownership changes.
