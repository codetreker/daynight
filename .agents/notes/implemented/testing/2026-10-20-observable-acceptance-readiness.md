# Agent Note: Observable Acceptance Readiness

Status: implemented

## Problem

Acceptance drivers can act before the component being tested reaches the state
that an assertion assumes. An HTTP handler can be entered before PostgreSQL
executes its query, and a shell command can print a completion marker before the
next interactive editor exists. A cached browser control can also be visible
before a live read enables interaction. Those signals can produce network-write
errors, dropped input or an incorrect modal opener while leaving the intended
cancellation, completion or focus behavior unobserved.

## Decision

Database cancellation, shell interaction and browser platform tests synchronize
on observable execution readiness. Production code, public protocols, existing timeout bounds
and acceptance assertions remain unchanged.

The server runtime tests run a uniquely marked sleep query. An independent pgx
connection matches the exact SQL, current database and a different backend PID
in `pg_stat_activity`, requiring `active`, `Timeout` and `PgSleep` before the
client is canceled or forced draining begins. Polling and observer closure are
bounded. Buffered result channels preserve assertion values; independent closed
completion channels let failure cleanup cancel requests, stop the runtime and
join both goroutines even after results were consumed. Strict context errors,
the 30 ms drain deadline, the one-second shutdown bound, HTTP timeout and pool
health checks retain their meaning. The
[server design](../../../../docs/design/daynight-server.md) owns those guarantees.

The PTY driver first waits for a new primary-prompt generation and then requests
a dedicated Readline/ZLE widget acknowledgement for that same generation, an
empty buffer and cursor zero. Setup and actual command execution await the next
prompt generation. Discarding test input uses a queued editor reset widget that
clears the buffer and cursor, then acknowledges the same generation. A second
pipe blocks the capture widget after its marker; a queued reset cannot
acknowledge until that widget is released. The first
prompt of each real shell is blocked by an inherited anonymous pipe. A queued
probe receives no editor acknowledgement during the former 30 ms quiet window;
after releasing the gate, the real editor must acknowledge it. This proves the
transition directly without adding sleeps or increasing deadlines. All candidate,
argv, cursor, startup and no-CLI-on-Tab assertions remain intact. The
[completion design](../../../../docs/design/daynight-completion.md) owns the
interactive validation mechanism.

Browser platform helpers wait for the select to be enabled before focusing it,
then verify focus before selecting an option. Cached task details can render
while the live authoritative read still disables metadata writes. A focus call
on that disabled select has no effect; the later actionability wait inside
`selectOption()` cannot repair the earlier missing focus. Establishing both
preconditions ensures the confirmation captures the intended opener. Cancel
still must preserve the saved value, return focus to the select and submit no
PATCH. No focus is forced after cancellation, and no assertion timeout or retry
policy is relaxed. The [Web design](../../../../docs/design/daynight-web.md)
owns the browser acceptance contract.

## Alternatives

**Treat handler entry or an in-command marker as readiness.** Those events occur
before the database execution or next editor phase. They do not establish the
precondition for the subsequent cancellation or input assertion.

**Wait for quiet output or add a fixed delay.** A blocked prompt transition can
be silent indefinitely, and scheduler delay changes the relationship between
elapsed time and readiness. The pipe-gated counterexample retains a quiet window
while proving that the editor is still unavailable.

**Clear input with an asynchronous terminal interrupt.** A capture marker can
be printed while its widget is still running. An interrupt delivered in that
phase does not establish a fresh primary prompt or empty editor. Queuing a reset
through the editor performs the intended buffer edit after the capture widget
returns.

**Accept more cancellation errors or retry unchanged failures.** This would let
the database test pass without observing cancellation of running work and could
conceal the original phase race. The observation barriers preserve the existing
strict error and cleanup checks.

**Let option selection establish every interaction precondition.** Its own
actionability wait occurs after an earlier `focus()` call. If that call ran while
the select was disabled, the confirmation captures the page body and correctly
restores its fallback title. Waiting longer after cancellation cannot change
which opener was captured.

## Consequences

Tests require one additional observer connection and two shell readiness phases.
SQL markers and prompt generations isolate unrelated work and stale output.
The observer does not share the running query's connection or transaction;
cleanup remains possible after a failed readiness assertion. Browser helpers
observe enabled and focused states before their selection event, so cached
rendering remains covered without assuming it already permits edits.

The focused race probe passed both database cases across 20 iterations each,
and the complete server gate passed build, vet, race, critical coverage checks
and the raw strict comparison at 1153/1155 statements. The three real shells
passed their 46 existing scenarios each, both gated readiness proofs per shell
and the zsh initialization refusal (145 checks). These local receipts describe their tested
sources; required hosted checks and review still govern integration.

No runtime behavior, database schema, command grammar or completion candidate
changes are part of this testing decision. No package-version increase is
required for test and documentation changes alone.
