# Agent Note: Raw JSON String Span Scanning

Status: implemented

## Problem

Large Worker configurations repeatedly pass through the bounded JSON encoder.
Although output batching bounds writer calls, dispatching string state and
escape checks for every ordinary byte creates hundreds of millions of atomic
coverage updates in the exact-capacity migration test. Race instrumentation
amplifies that work. Existing profiles show substantial instrumentation cost,
but do not establish why identical source previously ran faster on the host.
The 4 MiB boundary, real persistence checks, and 90-second deadline remain
necessary regression proofs.

## Decision

After validating a RawMessage, the encoder uses `bytes.IndexAny` inside an
unescaped string to locate the next quote, backslash, HTML character, or literal
U+2028/U+2029. The search returns a byte offset; ordinary spans retain their
original bytes, including invalid UTF-8 accepted by `encoding/json` for raw
messages. Validated JSON guarantees a closing quote, so every such search finds
an event. Existing escape and string-state handling consumes that event.

The search visits each ordinary span once and does not allocate a complete
escaped representation. The [bounded batching decision](../testing/2026-11-08-bounded-raw-json-batching.md)
continues to own validation precedence, 4096-byte output chunks, accepted-byte
counting, budget rejection, and writer failure semantics. The capacity fixture
and database operations are unchanged.

## Alternatives

**Keep dispatching every byte.** Batching already reduced output calls, but
ordinary characters still performed repeated state checks and coverage updates.
Span search removes that repeated dispatch from the production path.

**Search separately for each event and take the earliest position.** Repeated
searches can revisit a long remaining suffix for every occurrence of another
event. A single search for the event set preserves linear scanning.

**Marshal the complete raw value first.** This creates memory proportional to
the escaped output before enforcing the budget, losing bounded intermediate
storage.

**Change the test boundary or instrumentation.** Smaller inputs, bypassed
encoding, longer deadlines, or disabled race/coverage would weaken the existing
proof instead of reducing its production cost.

## Consequences

Ordinary strings avoid per-byte state dispatch; dense escape sequences still
require per-event handling. Standard-library search retains its own CPU cost,
and this mechanism does not promise equal gains for every input distribution.
Oracle comparisons cover byte offsets, invalid UTF-8, backslash parity,
structure transitions, and sparse and dense events. Partial writes accompanied
by an error preserve the accepted count, exact prefix, and immediate stop.

Source-bound validation artifacts own timing, allocation, and profile results.
A faster focused test cannot substitute for the full module gate or explain
historical host variability.
