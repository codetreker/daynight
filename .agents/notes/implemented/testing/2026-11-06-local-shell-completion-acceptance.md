# Agent Note: Local Shell Completion Acceptance

Status: implemented

## Problem

Real-shell completion acceptance prepares Bash 4.2, modern Bash and zsh before
exercising interactive editing in a Python PTY. Running that independent
workload for CLI changes adds shell provisioning and execution to routine CI.
The project no longer requires that workload as a hosted merge gate.

## Decision

The `checks` workflow has no `verify-completion` job, and its final gate has no
dependency on that job. Native CLI tests and the runtime compatibility matrix
retain their existing selection and acceptance rules.

`pnpm completion:acceptance` remains available for local verification, together
with the isolated Linux shell preparation helper. Its real-shell scenarios and
receipt semantics remain intact. The [development guide](../../../../docs/development.md)
owns command usage, and the [completion design](../../../../docs/design/daynight-completion.md)
owns the observable shell behavior and test coverage.

The [original completion decision](../../archived/feature/2026-10-20-shell-completion.md)
retains the product and shell support rationale. This decision owns only where
real-shell acceptance runs. The [Ubuntu mirror decision](2026-10-22-ubuntu-package-mirrors.md)
continues to govern Web browser provisioning; shell-completion CI no longer
consumes that preparation command. The [version-only PR decision](2026-11-04-version-only-pr-ci.md)
continues to govern which PRs skip application verification, and the
[publication decision](../process/2026-10-22-cli-publication-validation.md)
continues to own the npm release gate.

## Alternatives

**Retain the independent hosted job.** It would continue producing revision-bound
Bash and zsh evidence on each selected CI run, at the cost of shell provisioning
and PTY execution that the project no longer requires in routine CI.

## Consequences

Routine CI avoids the separate shell preparation, real-shell execution and
completion artifact upload. Completion functionality, ordinary CLI regression
tests and the local acceptance command remain available.

A successful CI run no longer proves actual Tab insertion or startup-file
loading in Bash 4.2, modern Bash and zsh. That evidence requires running the
local suite and applies only to its tested revision and environment.
