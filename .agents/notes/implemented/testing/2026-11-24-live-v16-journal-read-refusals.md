# Agent Note: Live v16 Journal Read Refusals

Status: implemented

## Problem

Worker lifecycle scenarios need independent real v16 journals with a live owner
to verify stop, recovery, receipt, and conflict behavior. Checking both general
and current-only read refusals and comparing the whole journal in every fixture
repeats the same precondition before any scenario-specific operation.

## Decision

The [live journal tests](../../../../packages/daynight/test/commands/worker/web-live-journal.integration.test.ts)
verify the two read refusals in a dedicated live v16 case. It checks the
upgrade-blocked reason, the current-format refusal, and the original bytes after
each read. Every lifecycle scenario still creates and downgrades its own journal,
checks its version and live owner, captures its bytes, and retains its own
business and persistence assertions.

## Alternatives

**Repeat both checks in every fixture.** The inputs and read operations are the
same before the scenarios diverge, so repeated whole-file comparisons add cost
without testing their distinct Worker behavior.

**Rely on existing migration tests.** Other live-owner migration cases exercise
different historical formats and do not establish both read paths for this v16
fixture.

## Consequences

The refusal proof executes once alongside all original lifecycle scenarios.
It does not replace their real SQLite files, platform-specific paths, or their
own assertions after Worker actions. A change to the fixture or either reader
must preserve the dedicated refusal and byte-preservation proof.
