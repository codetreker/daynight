# Agent Note: Bounded Raw JSON Batching

Status: implemented

## Problem

The bounded protocol encoder emitted each ordinary byte of a RawMessage through
its writer and formatted each HTML escape separately. Large encoded resources
therefore performed millions of writer calls and small formatting allocations.
Race and coverage instrumentation amplify those costs in capacity-bound tests.
The encoder must still reject unsupported input, preserve encoding/json byte
semantics, and stop output without allocating a complete oversized resource.

## Decision

RawMessage encoding validates the entire input before touching the output
writer. A span scan removes whitespace outside strings, preserves existing JSON
escapes and raw byte semantics, and emits constant escapes for literal HTML
characters and U+2028/U+2029. Output passes through a buffer capped at 4096 bytes;
small inputs use a smaller buffer, and ordinary spans are explicitly split at
the same cap. No complete escaped output is constructed in memory.

The existing bounded Writer retains its byte-budget contract. A violation names
the first rejected size, Max+1, as a lower bound; it does not measure the rest of
the resource. Count remains the bytes accepted by the underlying writer, and
writer failures or short writes retain their error identity. A rejected batch
can leave a shorter output prefix than byte-at-a-time output, while never
writing beyond the budget. Neither prefix is a successful JSON representation.

Parity tests compare actual output with encoding/json across buffer boundaries,
literal and pre-escaped characters, nested values, and invalid UTF-8 in a
RawMessage. Exact and one-byte-over budgets, midstream writer failures, and
invalid JSON before budget or writer access preserve independent failure proofs.
The [test dependency decision](2026-11-08-go-test-dependency-boundaries.md)
separates those codec guarantees from the HTTP and storage tests that consume
them.

## Alternatives

**Keep byte-at-a-time writes and replace only formatting.** Constant escape
strings remove formatting allocations, but every input byte would still cross
the writer and budget checks.

**Marshal a complete RawMessage before applying the budget.** Standard encoding
provides the byte oracle, but constructing the full escaped value consumes
memory proportional to oversized output before rejecting it.

**Change capacity fixtures to avoid RawMessage escaping.** That would make tests
cheaper by bypassing the measured encoding path and weakening its regression
signal. Capacity and representation vectors remain unchanged.

## Consequences

The codec preserves its supported types, default HTML escaping, optional newline,
validation precedence and error contracts while bounding intermediate storage
and writer-call frequency. String encoding shares the same chunk cap without
changing its rune-boundary handling.

The shared codec serves several protocol consumers. Their actual byte budgets
and response contracts remain independent, and their existing validation gates
must still execute. Source-bound timing and profile artifacts own measured
performance claims; this note records the encoding mechanism and its costs.
