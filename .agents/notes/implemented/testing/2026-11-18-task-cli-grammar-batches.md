# Agent Note: Task CLI Batches

Status: implemented

## Problem

The compiled Task help and malformed-input matrix originally started 71 Node
processes serially. The matrix took 5.96 seconds in a
[macOS PR run](https://github.com/codetreker/daynight/actions/runs/44233092227/job/134562734151)
and 8.75 seconds in a
[nearby main run](https://github.com/codetreker/daynight/actions/runs/44233815549/job/134568762840).
Each input needs to exercise the compiled dispatcher, diagnostics, and import
restrictions. Three read-only matrices also started 20 processes to inspect
dependency rendering, status and readiness filtering, and property rendering.
Their assertions concern command output and requests to a loopback server.

## Decision

The [Task CLI test](../../../../packages/daynight/test/cli/task.test.ts) keeps
four cold executable invocations for the grammar matrix, including nested
attachment commands. The other grammar inputs use two serial batches through
the compiled `runCli` and its real command registry. Each batch installs one
immutable import guard before loading the application. Help and validation use
separate processes so the stricter policy observes cold imports. Both paths
check diagnostics and the absence of changes to HOME and the working
directory.

Each selected read-only matrix uses its own batch process. Invocations run in
order with fresh production contexts, separately captured output and exit
codes, and real loopback HTTP. The status and readiness matrix verifies the
sequence of project and task requests before checking query parameters.
Independent executable invocations cover versioned writes, raw-byte and stream
contracts, Git integration, and process lifetime. The property matrix runs
its writes through the executable and batches the intervening read-only
observations.

## Alternatives

**Launch the cold processes concurrently.** This retains process startup,
increases contention, and requires separate environments to preserve isolation.

**Share a process across import policies.** Modules admitted under the
validation policy could already be cached when tested under the stricter help
policy. Each process keeps one policy from startup through exit.

## Consequences

The 71 grammar inputs use six processes and the 20 selected read-only calls use
three. Representative cold invocations check startup and exit-code wiring.
Batched reads share a module cache and use fresh command contexts and
independent output capture.
