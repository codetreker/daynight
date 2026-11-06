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

The Go workflow sets `DAYNIGHT_TEST_RACE` explicitly from the event: `false` for
PR validation and `true` for main pushes. The module check accepts only literal
`true` and `false`; an absent value retains the enabled local default. Invalid
values fail before fixture preparation. It passes explicit race values to
`go-cov`, preserving the checked-in race-enabled local configuration.

The [pinned go-cov implementation](https://github.com/codetreker/go-cov/blob/d6caf2759e330b48d69a543695e37002a48feb1d/internal/coverage/run.go#L159-L169)
adds a child `go test -race` flag only when enabled; `--race=false` omits it.
Disabled coverage appends `-race=false` to inherited `GOFLAGS`, preserving other
flags while overriding ambient `-race`. Enabled/default modes let the tool's
explicit child flag select test instrumentation without instrumenting the
coverage runner itself. Build, vet, module functional/concurrency checks and all
coverage thresholds retain their responsibilities in either mode.

The original two-job implementation also applied explicit race values to E2E and
built its child service from the parent test binary's actual race build tag.
Its process receipt recorded `raceEnabled`, and orchestration receipts recorded
command arguments. The [Go module boundary](2026-11-06-go-module-validation-boundary.md)
removes that process package and its receipts while retaining this event policy.
The [independent jobs](2026-11-04-server-e2e-ci-jobs.md) and
[package extraction](2026-11-03-server-e2e-package.md) records preserve the earlier
always-race context and the reasons for matching child instrumentation.

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
module command rather than inferred from a job name.

Short ping timing removes a known observation delay while retaining the real
connection. Package execution overlaps, and compilation, database preparation and
other tests remain, so the removed delay is not a guaranteed whole-job saving.
Bash toolchain caching and GUI assertion observation changes remain separate
candidates: they can be added independently after measurement without changing
this event policy or the existing input and stability requirements.
