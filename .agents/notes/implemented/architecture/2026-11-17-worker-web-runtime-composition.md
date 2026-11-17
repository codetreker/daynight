# Agent Note: Web-only Worker runtime composition

Status: implemented

## Problem

A Worker that no longer owns old Herdr executions must not construct an instance or treat retained Herdr records as active tool selections. Doing so can start or stop resources that belong to user-directed cleanup and can block unrelated Web execution.

## Decision

Worker run and management compose the Web store and backend as required coordinator dependencies. Tool selection prepares and freezes Web recipes and reports Web and Bot activity. Management refuses an old Herdr execution before opening a backend. The existing public tool and context slots remain for the current wire contract; unobserved slots do not acquire synthetic probe results. Web probe and materializer cleanup retain their original owners.

The uncalled Herdr shared and durable backend roots, adapter, and runtime version observer are removed. Remaining Herdr-specific leaf modules retain their existing types until their own consumers are removed; no replacement backend or synthetic probe takes their place.

This supersedes the runtime admission and shared instance ownership in the [Herdr launch decision](2026-11-12-herdr-frozen-tool-launch.md), while preserving the Web ownership described in the [frozen runtime decision](2026-11-12-worker-frozen-tool-runtime.md).

## Alternatives

**Retain the shared instance for old records.** This would continue operational responsibility for processes and claims explicitly left to users and could make Web admission depend on their state.

**Narrow all tool and context types together.** Current protocol consumers still use the wider wire; changing it here would couple runtime removal to a separate contract migration.

## Consequences

Old Herdr resources are neither observed nor managed by this runtime. They are not proven stopped or cleaned up. Web and Bot still require their real tool inspection and cleanup; an unavailable or unconfirmed probe remains a failure rather than a fabricated success.

The uncalled Herdr local recording sampler, store, archive writer and resource
orchestration are also removed. Uploaded historical recordings retain their
independent read-only format and integrity checks; existing local resources
remain the user's responsibility. Input and lifecycle leaves remain until their
own consumers are removed.
