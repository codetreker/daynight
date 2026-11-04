# Agent Note: Event-specific Go Validation Timing

Status: implemented

## Problem

Go validation combines production package coverage and real-process acceptance.
Race instrumentation adds cost to both the test process and the server built by
its E2E harness. Choosing the mode in only one layer leaves part of the workload
instrumented or makes the reported mode disagree with the actual binary.

The WebSocket ping case also used an eleven-second observation window to cross
the production ten-second ping period. The desired evidence is an actual browser
ping response followed by an application event on the same connection; the full
production interval is not part of that protocol assertion.

## Decision

The two Go workflow jobs set `DAYNIGHT_TEST_RACE` explicitly from the event:
`false` for PR validation and `true` for main pushes. The Node orchestrator accepts
only literal `true` and `false`; an absent value retains the enabled local default.
Invalid values fail before fixture preparation. It passes explicit race values to
both `go-cov` and `go test`, preserving the checked-in coverage configuration's
race-enabled local default.

The [pinned go-cov implementation](https://github.com/codetreker/go-cov/blob/d6caf2759e330b48d69a543695e37002a48feb1d/internal/coverage/run.go#L159-L169)
adds a child `go test -race` flag only when enabled; `--race=false` omits it.
Disabled coverage therefore appends `-race=false` to that command's inherited
`GOFLAGS`, preserving the other flags while overriding an ambient `-race`.
Enabled and default modes leave inherited `GOFLAGS` unchanged: the tool's
explicit child flag selects target-test instrumentation without newly
instrumenting the go-cov runner itself. E2E and its embedded server already pass
explicit race values to their Go commands.

The E2E test package derives its server build mode from the actual parent test
binary's race build tag. A direct local `go test -race` therefore builds a matching
server without relying on an environment claim. The process receipt records
`raceEnabled`, and the orchestration receipts retain their explicit command
arguments. Both modes keep build, vet, complete functional and concurrency
scenarios, installed artifact provenance, cleanup and atomic statement coverage.
The package/function/critical-block gates and strict total coverage greater than
90% retain their existing semantics.

This policy partially supersedes the always-race CI execution retained by the
[independent jobs decision](2026-11-04-server-e2e-ci-jobs.md) and
[E2E package decision](2026-11-03-server-e2e-package.md). Their resource, coverage
and scenario boundaries remain. Main CI and ordinary local validation retain
race instrumentation; PR feedback uses uninstrumented execution.

The ping case injects a short private interval before opening the connection,
observes an actual incoming ping through the client's protocol callback, and
keeps the reader's real pong response and subsequent application-event assertion
on the same connection. Production retains its ten-second interval, and the
original connection and test deadlines stay independent. No fake WebSocket or
new production configuration interface replaces the protocol interaction.

The [server validation guide](../../../../packages/daynight-server/README.md#race-instrumentation)
owns commands, accepted values and receipt interpretation.

## Alternatives

**Disable race instrumentation in every CI event.** This would reduce main's
validation work as well as PR latency, but remove the retained mainline detector.
The event-specific policy keeps it on main and in normal local validation.

**Inspect `CI` presence inside the runner.** PR and main jobs both set `CI`, so it
cannot express their different instrumentation requirements. The workflow owns
the event and supplies an explicit value.

**Change only the coverage configuration or outer Go command.** The E2E harness
builds its own server. A single-layer change would leave a different actual mode
inside that child; deriving the build from the parent test binary preserves one
observable mode across direct and orchestrated execution.

**Wait a shorter fixed duration in the ping case.** A shorter sleep would still
use scheduling time as a proxy for receiving a ping. Observing the real control
frame preserves the protocol event and removes dependence on the production
period.

## Consequences

PR validation still executes the same workloads and thresholds, with race
instrumentation deferred to main and ordinary local execution. A passing PR check
does not by itself establish race-detector coverage. The mode is explicit in the
commands and process receipt rather than inferred from a job name.

Short ping timing removes a known observation delay while retaining the real
connection. Package execution overlaps, and compilation, database preparation and
other tests remain, so the removed delay is not a guaranteed whole-job saving.
Bash toolchain caching and GUI assertion observation changes remain separate
candidates: they can be added independently after measurement without changing
this event policy or the existing input and stability requirements.
