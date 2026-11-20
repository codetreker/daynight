# Agent Note: Project CLI Grammar Batch

Status: implemented

## Problem

The compiled Project help and malformed-input matrix issued thirteen invocations
in separate Node processes. Each input must exercise compiled command parsing
and diagnostics under its import policy. Representative inputs can demonstrate
the executable's startup and exit-code handling.

## Decision

The [Project CLI test](../../../../packages/daynight/test/cli/project.test.ts)
launches the executable for bare Project help, create help, a missing create
operand, and malformed project IDs. The other nine inputs run serially in one
child process with the same import guard installed before the compiled
application loads. Each invocation gets its own production CLI context, exit
code, and captured output. The malformed-ID case uses its own guard and its own
executable process.

## Alternatives

**Launch the executable for every input.** This repeats startup for inputs
that exercise the same dispatcher and import policy. The representative cold
invocations cover the entry point.

**Batch the malformed-ID case with the other inputs.** This would mix two
import policies in one module cache. The existing
[Task CLI batching decision](2026-11-18-task-cli-grammar-batches.md) records why
each guarded process has one policy.

## Consequences

The matrix runs all thirteen inputs with five processes. The regression for
Unicode U+0085 still fails when the name is accepted and a forbidden business
module is imported. The cases for HTTP, Git, filesystem, and publication still
exercise the compiled executable in their own processes.
