# Agent Note: Native Validation Probe Isolation and Diagnostics

Status: implemented

## Problem

Native validation must identify the tools that actually run and preserve evidence
when discovery fails. A Windows mainline
[environment step](https://github.com/codetreker/daynight/actions/runs/39240881682/job/118021101519)
failed before tests because `gh --version` exceeded its 10-second subprocess
deadline. The collector wrote its only receipt after every command succeeded,
so the failure lacked executable identity, elapsed time and partial output.

The workflow, CLI and dependency files were unchanged between the approved PR
head and the failing main commit. Passing PR and earlier main jobs used the same
runner/image and tool versions. This localizes the failed operation but does not
establish why that process stalled or prove a transient infrastructure cause.
The original failed run remains available; it was not rerun unchanged.

## Decision

The environment collector records each command's start, executable resolution,
launcher, duration, exit/signal and bounded stdout/stderr. It writes and streams
the command state before executing and records failures before propagating the
original error. The full environment receipt still requires every native tool
version and SQLite measurement to succeed.

Only the `gh` version child receives project-local `GH_CONFIG_DIR`,
`XDG_STATE_HOME`, `XDG_DATA_HOME` and `GH_TELEMETRY=0`. Parent authentication and
configuration remain unchanged. Configuration alone does not select gh's
state/data directories; see the pinned
[directory rules](https://github.com/cli/go-gh/blob/v2.16.1/pkg/config/config.go#L265-L295).

This removes unnecessary probe state and telemetry work. gh initializes
configuration and telemetry before the version command, including state-file
work in its
[telemetry implementation](https://github.com/cli/cli/blob/fc4b137cdef0a6bd28fd461b7cf9c84a5812a8cd/internal/telemetry/telemetry.go#L38-L87).
Its [update notifier](https://github.com/cli/cli/blob/fc4b137cdef0a6bd28fd461b7cf9c84a5812a8cd/internal/update/update.go#L81-L90)
is disabled in CI/non-TTY operation. These facts explain the isolation choice;
they do not establish the original timeout's trigger.

Executable resolution reuses the frozen cross-spawn 7.0.6 implementation rather
than implementing a second PATH/PATHEXT/shim algorithm. Diagnostics distinguish
the requested tool file from a Windows command launcher. The production call
inherits the parent environment apart from gh state settings; Windows regression
tests control parent and child PATHEXT together because the pinned resolver
consults the parent process for extension order.

CI uploads a separate probe artifact even when collection fails. The upload
runs after the complete original validation and acceptance artifact steps, so
the additional artifact operation cannot prevent those tests from running.
At adoption, the 10-second subprocess deadline, 1 MiB capture bound, mandatory
tool success, native test workload and 600-second job deadline were unchanged.
The later [cold-start preparation decision](2026-10-20-gh-cold-start-preparation.md)
adds selected-file preparation and measured provenance to gh discovery; resolution,
preparation and execution now share one 10-second gh budget. The isolation and
incremental diagnostics remain in use. Native versions, capture bounds, the full
workload and the job deadline remain required, with no command retry, alternate
version source or fallback receipt.

## Alternatives

**Retry the unchanged failed workflow.** The available evidence does not prove
a transient cause. A retry would provide neither the missing process evidence
nor a new validation guarantee.

**Increase the probe or job deadline.** This would relax existing acceptance
conditions without explaining the stall. Isolation and diagnostics preserve the
limits and make any recurrence observable.

**Read version metadata instead of executing the native tool.** Metadata does
not prove that the selected executable launches. The native command remains the
source of the receipt.

**Upload diagnostics before tests.** Artifact service failure would then skip
type checking, tests and acceptance through default step conditions. Uploading
last preserves the actual validation workload.

## Consequences

The collector has direct child-process tests for success, nonzero exit, missing
executable, empty version, timeout, bounded partial output and state isolation.
Windows additionally verifies the selected shim and command launcher. Its batch
fixtures contain only ASCII source, receive the Node executable through their
scoped environment, and locate payloads through quoted `%~dp0`; Chinese and
space-containing directories remain part of the test. This avoids depending on
the console codepage to decode literal Unicode paths. Failed fixtures print
bounded probe evidence before cleanup. The failure artifact can distinguish
resolution from process execution and retain
the failed command's result.

Native CI remains necessary to validate platform behavior. The historical stall
is still unexplained, and this design does not claim that every future startup
timeout is prevented. Any further failure remains a failure with recorded
evidence, rather than an automatic retry. Future dependency updates must verify
the private pinned resolver contract through the same native tests.
