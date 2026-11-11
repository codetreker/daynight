# Agent Note: Active Worker Claims on Task Chains

Status: implemented

## Problem

A collapsed project task chain does not reveal whether a Worker has claimed any
member. Permission to run automatically and Session activity cannot establish
that a claim is active.

## Decision

The project chain header displays a noninteractive localized indicator when any
member of its complete ordinary dependency component has an active Worker claim.
It uses the existing project snapshot projection, includes the representative
and out-of-scope ordinary members, and excludes external prerequisites. Complete
scope rows place it after the assignee; cross-scope rows place it beside the task
count without exposing the out-of-scope representative's assignee. The [Web
specification](../../../../docs/spec/daynight-web.md) owns the visible behavior.

## Alternatives

**Use automatic execution permission or Session activity.** Permission does not
mean a Worker has acquired a claim, and Session activity has its own lifecycle.
Either would give the indicator a different meaning.

**Aggregate only visible members.** A cross-scope chain would hide an active
claim in the same ordinary component, despite retaining the complete chain as
its context.

## Consequences

The indicator updates with the existing snapshot without per-row requests or a
new polling channel. It describes active claims, not Worker health or Session
activity. Cross-scope progress and Session summaries retain their own boundaries.
