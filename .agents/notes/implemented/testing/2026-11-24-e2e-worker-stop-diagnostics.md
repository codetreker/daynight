# Agent Note: E2E Worker stop diagnostics

Status: implemented

## Problem

A Worker patrol can fail at its first explicit stop even when its task claim
and Session were ready. The same generic failure can mean a nonzero Worker
exit or an unconfirmed process-group stop. Completion itself waits for the
same group stop, so a rejection from both observations can represent one
failure. Without the original causes, exit status and output, a retained
interrupted fixture cannot identify the failed boundary or establish a leak.

## Decision

The command runner retains bounded output and the original leader exit code
and signal even when completion rejects. The gated target reports its own exit
code and signal through the two gates; a missing report stays unknown. The
Worker patrol requires a zero target exit, zero gate exit and a confirmed group
stop. It records each launch's observations and failures with the run logs
before marking the fixture stopped. The report includes output truncation and
preserves setup, scenario, stop and recording errors in serialized diagnostics.
The [product E2E decision](2026-11-08-self-contained-product-e2e.md) owns the
independent recovery and resource-proof requirements.

## Alternatives

**Infer normal shutdown from a stopped group.** The group can be stopped after
an unsuccessful Worker shutdown. This would erase the distinction between
process cleanup and the Worker's own shutdown proof.

**Report only the outer gate status.** The gates convert a signal-terminated
child to a nonzero exit; that status cannot identify the Worker's actual signal.
The target report is diagnostic evidence and does not replace process ownership.

## Consequences

A later failure retains the preceding stop observations and bounded Worker
output. Lost target reports fail the patrol rather than inventing an exit.
Unconfirmed cleanup still retains private ownership state. Historical failures
without these observations cannot be attributed to a particular exit or process
stop mechanism by a later successful run.
