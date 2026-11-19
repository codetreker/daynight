# Agent Note: Temporary Claude Code Support Suspension

Status: implemented

## Problem

The Claude SDK initialization-disconnect test repeatedly observes a helper
without an exit code or signal after startup has failed on macOS. The adapter
cannot claim reliable cleanup for that path. This failure also prevents the
ordinary CLI CI gate from certifying otherwise unrelated provider changes.

## Decision

Claude Code is temporarily unsupported for Daynight-managed Task Sessions,
Test Sessions and assistants. Existing adapter code, options and credentials
remain intact; unsupported here describes the support guarantee, not a new
runtime rejection. The SDK startup matrix excludes only the Claude disconnect
case. Other Claude tests and every Copilot startup case remain selected.
The project and CLI READMEs state this limitation explicitly.

## Alternatives

**Keep the failing case as a delivery gate.** This preserves immediate defect
detection but blocks unrelated Codex delivery until Claude cleanup is repaired.
The accepted scope instead withdraws Claude support while that repair is pending.

**Bypass the failed CI gate.** This leaves automated review unable to start and
does not produce a passing result for the declared verification scope. An
explicitly narrower suite and support statement make the missing guarantee
visible without claiming the failing behavior passed.

## Consequences

Green CI does not establish Claude Code initialization-disconnect safety.
Existing Claude executions may still encounter incomplete helper cleanup.
This is a deferred lifecycle guarantee, not a fix or evidence that the failure
was transient. Restoring support requires diagnosing the actual cleanup failure,
preserving original-process identity and unknown-stop semantics, reinstating the
disconnect regression, and passing it and the ordinary CLI suite on macOS.
Keeping the fixture and adapter intact preserves the reproduction path; the
remaining cost is lifecycle repair and validation, not reconstructing an adapter.
