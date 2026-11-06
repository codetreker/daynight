# Agent Note: Module validation routing

Status: implemented

## Problem

The PR selector schedules Go validation for Web changes even though the Go
module job no longer builds the Web application. It also omits Go when shared
Session fixtures change, despite Go tests reading that corpus. Routing by stale
dependencies spends time on unrelated validation and can skip actual consumers.

## Decision

PR routing follows the inputs consumed by the current module jobs. Web files
and selected JavaScript patches select Web. CLI implementation imported by Web
selects CLI and Web. Neither input family selects Go solely because production
builds embed the Web bundle.

The [Go job](https://github.com/codetreker/daynight/blob/47d9262c84bedf3d96dd1298f764f6ba5b201aaf/.github/workflows/checks.yml#L350-L412)
runs the module check with a
[fixed Web resource overlay](https://github.com/codetreker/daynight/blob/47d9262c84bedf3d96dd1298f764f6ba5b201aaf/packages/daynight-server/scripts/check.sh#L17-L21).
The [Go coverage boundary](2026-11-06-go-module-coverage-boundary.md) owns that
module validation. Production Web embedding retains its build requirements.

The entire `packages/daynight/test/session/fixtures/` directory selects CLI,
Web and Go. Go reads
[non-v2 command fixtures](https://github.com/codetreker/daynight/blob/47d9262c84bedf3d96dd1298f764f6ba5b201aaf/packages/daynight-server/internal/core/session/protocol/command_test.go#L12-L25),
[manifest-selected v2 cases](https://github.com/codetreker/daynight/blob/47d9262c84bedf3d96dd1298f764f6ba5b201aaf/packages/daynight-server/internal/core/session/protocol/v2/contract_test.go#L53-L72)
and [responsibility digest vectors](https://github.com/codetreker/daynight/blob/47d9262c84bedf3d96dd1298f764f6ba5b201aaf/packages/daynight-server/internal/core/session/protocol/v2/responsibility_test.go#L10-L29).
Directory ownership preserves those consumers as manifests gain cases.

The [README routing table](../../../../README.md#ci-selection) owns the input
families. This replaces the production-embedding assumptions in the archived
[module-scoped CI decision](../../archived/process/2026-10-21-module-scoped-pr-ci.md).
Complete merge-base diffs, deletion and rename handling, shared root inputs,
unknown-path selection, full main-push validation and final checks retain their
existing behavior.

## Alternatives

**Keep the production dependency graph as the PR job graph.** This schedules Go
for Web changes without exercising those changed files in the Go module job.

**Remove every Go dependency on CLI-owned files.** This skips Go tests when their
shared Session protocol inputs change.

**List individual fixture files.** Direct archive reads cover only part of the
corpus. Dynamic manifest and digest-vector readers make a per-file list brittle
when a new case is added.

## Consequences

Web-only PRs run Web validation, while shared Session fixture changes retain all
three module consumers. Mixed changes select the union of their consumers.
Future module input changes require updating the selector and its regressions;
production relationships alone do not establish module-job consumption.
