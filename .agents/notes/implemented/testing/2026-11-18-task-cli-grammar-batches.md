# Agent Note: Task CLI Grammar Batches

Status: implemented

## Problem

The compiled Task help and malformed-input matrix started 71 Node processes
serially. Every input needs to exercise the compiled dispatcher, diagnostics,
and import restrictions, but process startup itself only needs representative
coverage. The matrix took 5.96 seconds in a
[macOS PR run](https://github.com/codetreker/daynight/actions/runs/44233092227/job/134562734151)
and 8.75 seconds in a
[nearby main run](https://github.com/codetreker/daynight/actions/runs/44233815549/job/134568762840).

## Decision

The [Task CLI test](../../../../packages/daynight/test/cli/task.test.ts) keeps
four cold invocations of the compiled executable: two help and two malformed
inputs, including nested attachment commands. The rest of the matrix uses two
bounded serial batches through the compiled `runCli` and its real command
registry. Each batch starts with one immutable import guard installed before
the application loads; help and validation never share a module cache. Each
invocation uses a fresh production context and captures its own output and
exit code. Both paths use the same assertions, including unchanged HOME and
working-directory checks. HTTP, Git, filesystem, and process lifetime cases
retain their executable invocations.

## Alternatives

**Launch multiple cold processes concurrently.** This retains all 71 launches,
increases contention, and requires separate environments to preserve isolation.

**Share a process between the two import policies.** Modules admitted under the
validation policy could already be cached when tested under the stricter help
policy. Each process therefore keeps one policy from startup through exit.

## Consequences

The same 71 argument vectors use six child processes. The matrix tests command
behavior with a fixed import guard, while the representative cold cases also
verify the executable's startup and exit-code wiring. Cases that intentionally
initialize business dependencies remain outside the batches.
