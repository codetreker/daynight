# Agent Note: Team Members Browser Evidence

Status: implemented

## Problem

The Team member navigation scenario must verify a dispatched self-exit across
another Team and a Task before exposing an unknown result after access is lost.
An unresolved fixture gate can leave its wait without an actionable failure
location, and a URL change alone does not establish that the Task was rendered.
Failure screenshots and traces are needed to distinguish a rejected or undispatched
write from later navigation and product lifecycle failures.

## Decision

The scenario checks the original actor, membership version and held DELETE
before navigating. It serves a principal-bound Project and Task fixture and waits
for the Task content while the original write is still held. The gate is released
on every exit. A bounded assertion reports the observed writes when dispatch does
not reach the gate. The Team members browser run retains failure traces, and its
results are included in the existing Web browser evidence artifact.

## Alternatives

**Wait only for the Task URL.** History changes synchronously before React has
necessarily committed the Task route; this can skip the lifecycle under test.

**Increase the overall test timeout or retry.** Neither distinguishes an
undispatched operation from a lifecycle failure, and both can hide the original
failure.

## Consequences

The scenario preserves the unknown and 404 assertions and verifies the Task
content before releasing the write. A timeout at the dispatch assertion now
reports the actual fixture writes. A retained trace provides additional evidence
for failures, but neither a passing run nor the trace configuration establishes
the cause of an earlier run whose artifacts were not retained.
