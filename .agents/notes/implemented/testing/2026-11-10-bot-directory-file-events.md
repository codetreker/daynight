# Agent Note: Original Bot Directory File-Event Investigation

Status: implemented

## Problem

A directory handle can close after `rm` reports a sharing violation and before
a reactive handle snapshot resolves its name. A successful synthetic holder
control proves the observer works for that holder; it cannot recover an earlier
fixture's open/share/cleanup history. Instrumenting the fixture also changes
its timing, limiting comparison with the original failing source.

## Decision

The separate Windows Bot diagnostic entry starts a bounded Kernel-File ETW
session before Vitest and Controller startup. A native known-holder control
checks the actual Windows provider schema, PID observations, sharing data and
open-to-cleanup/close history before original-case rounds are admitted. Raw
header PID and issuing thread fields remain observations when attribution is
unresolved; an execution-context PID is not automatically a lock holder.

Publisher metadata can expose event IDs and versions without payload templates.
That descriptor preflight admits only the known-holder control. Its actual
decoded records must verify the required payload fields and declared versions
before the original fixture can run; missing templates do not become a claim
that the payload schema is valid.

The runner temporarily replays the PR base's Bot fixture, retaining its exact
assertions and teardown. It records both source identities and restores the
checked-out bytes on every path. Fresh Vitest processes execute the original
prefix in order, including the successful Controller case before interrupted
parent observation. Five serial rounds are an upper bound; the first failure
stops further rounds, preserving its exit result and cleanup errors. Ordinary
suite budgets and production code remain unchanged.

Every ETW session has a unique persisted ownership receipt before startup.
Capture is non-circular and capacity-bounded. Begin/end markers and final loss
statistics establish coverage; missing markers, missing counters or lost data
remain incomplete evidence. Conversion and cleanup have their own bounded
reserve, and an independent cleanup step stops only the recorded session and
restores the original fixture.

Raw ETL/XML files remain private and are removed after filtering. Retained
events must match the verified DOS/device aliases of an owned `ordinary`
directory or its bounded FileObject/Irp lifetime. Pointer reuse cannot carry
unrelated paths into that history. A random directory is bound to the actual
test/failure window before attributing its events.

The path-selected PR investigation workflow is separate from required normal
validation. Its baseline-fixture result is diagnostic evidence, not acceptance
of the checked-out tests and not a substitute for the ordinary `checks` gate.
The [development guide](../../../../docs/development.md#cli-test-fixtures) owns
the entry and its evidence boundaries. The
[teardown decision](2026-11-05-bot-fixture-teardown.md) owns joined fixture cleanup
and the reactive handle observer. The
[checkout-source decision](2026-11-09-checkout-source-ci-validation.md) continues
to govern ordinary validation.

## Alternatives

**Use only the post-error handle snapshot.** It identifies a still-open handle
but loses a short-lived holder after closure and cannot reveal its sharing mode.
The [Kernel File create event](https://learn.microsoft.com/en-us/windows/win32/etw/fileio-create)
retains FileObject and sharing data for lifecycle correlation.

**Repeat the instrumented fixture as ordinary CI.** More green runs would still
not identify the earlier holder, and the altered fixture would remain a
different timing experiment. The explicit baseline replay states exactly which
test bytes ran and preserves the existing acceptance workflow.

**Retain a JavaScript child reference as a cleanup fix.** Node's active native
process wrapper already retains its owner; `unref` changes event-loop liveness.
No evidence establishes that this reference is the directory-lock cause.

**Increase cleanup retries or weaken the stop assertion.** Neither identifies
the holder. Persistent removal failure and uncertain ownership must stay visible.

## Consequences

The investigation can retain file activity after handles vanish, with explicit
source, coverage and attribution limits. It adds Windows-only diagnostic tools
and private trace cleanup, without enabling production-wide tracing or adding
stress work to routine module tests. A missing recurrence or unresolved PID
remains an open diagnosis rather than a successful repair.
