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

The [native Task CLI test](../../../../packages/daynight/test/cli/task.test.ts) keeps
four cold executable invocations for the grammar matrix, including nested
attachment commands. The other grammar inputs use two serial batches through
the compiled `runCli` and its real command registry. Each batch installs one
immutable import guard before loading the application. Help and validation use
separate processes so the stricter policy observes cold imports. Both paths
check diagnostics and the absence of changes to HOME and the working
directory.

The [Task protocol test](../../../../packages/daynight/test/cli/task-protocol.test.ts)
owns protocol-only filtering, pagination, exact versions, status, dependency,
property and response-rendering matrices. Both files use the
[compiled Task fixture](../../../../packages/daynight/test/fixtures/compiled-task.ts),
with the same executable and batch routes, per-case resources, import guards,
native environment and cleanup. Case names, assertions and timeouts are retained.
Portability classifies the behavior being proved; the protocol file still runs
the real compiled CLI and loopback HTTP. Ordinary CI selects both files on all
three native platforms.

Each selected read-only matrix uses its own batch process. Invocations run in
order with fresh production contexts, separately captured output and exit
codes, and real loopback HTTP. The status and readiness matrix verifies the
sequence of project and task requests before checking query parameters.
Independent executable invocations cover versioned writes, raw-byte and stream
contracts, Git integration, and process lifetime. The property matrix runs
its writes through the executable and batches the intervening read-only
observations.

Native or mixed cases remain in the native file, including Git discovery and
binding, HOME/USERPROFILE and PATH/Path behavior, guarded startup, Unicode
Markdown arguments, file and binary transfers, partial output, interrupted
responses and SIGINT. Attachment pagination and bounded ready cases remain
there conservatively because their original cases also guard native output or
filesystem behavior.

## Alternatives

**Launch the cold processes concurrently.** This retains process startup,
increases contention, and requires separate environments to preserve isolation.

**Share a process across import policies.** Modules admitted under the
validation policy could already be cached when tested under the stricter help
policy. Each process keeps one policy from startup through exit.

**Keep protocol and native assertions in one file.** This prevents a platform
selector from recognizing the protocol-only cases without also excluding native
mechanisms. Splitting complete cases preserves their identities and proof while
making the distinction explicit.

**Split mixed cases into smaller assertions.** This changes existing case
identities and redistributes their combined guarantees. Ambiguous cases retain
their complete native execution rather than qualifying only their protocol part.

## Consequences

The 71 grammar inputs use six processes and the 20 selected read-only calls use
three. Representative cold invocations check startup and exit-code wiring.
Batched reads share a module cache and use fresh command contexts and
independent output capture.

The two files contain 16 cases each. The Windows SIGINT skip stays in the native
file; the protocol cases have no platform skip. Shared fixture extraction does
not change configured worker limits, production behavior or CI selection.
Vitest can schedule the two files concurrently within those limits. File separation
is qualification input for platform selection and does not itself establish CI
wall-clock savings.
