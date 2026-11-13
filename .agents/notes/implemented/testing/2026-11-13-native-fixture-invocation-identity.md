# Agent Note: Correlating Native Fixture Invocations

Status: implemented

## Problem

An operating system can reuse a PID after a native fixture process exits. Matching
later requests to the first receipt with that PID can attribute a restored tool
invocation to an earlier process and report a false tool-selection failure.

## Decision

The Web tool selection fixture assigns each native process invocation a UUID and
records it in both the process receipt and every native request. The audit requires
exactly one matching receipt and independently checks the expected tool, process
ID, executable, arguments and worktree. A controlled test covers two invocations
sharing a PID and rejects mismatched or ambiguous evidence.

## Alternatives

**Match the PID and tool name.** This still cannot distinguish separate invocations
of the same tool when the PID is reused, and using the request's tool name as the
expected tool would weaken the independent selection assertion.

## Consequences

Process identity in the fixture remains stable across PID reuse while real
subprocess and recovery behavior remains under test. The identifier is test-only;
it does not establish process identity in production.
