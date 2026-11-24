# Agent Note: Worker Codex permissions on resume

Status: implemented

## Problem

The Codex app-server may recover a Worker thread under restrictive local
permissions when the native history has yet to record the thread's effective
settings. Command approval can then block an unattended task. The [Herdr
launch decision](../../archived/architecture/2026-10-27-worker-full-access.md)
previously applied the same Worker permissions on start and resume.

## Decision

Worker-owned Codex threads request `danger-full-access` and `never` on both
`thread/start` and `thread/resume`. The app-server receives an explicit
permission policy at each launch. Independent Controller sessions retain
their own configuration and native resume behavior.

## Alternatives

**Rely on native history.** This preserves user-selected permissions where they
were stored, but can fall back to local defaults during recovery before the
first turn. The Worker requires deterministic unattended launch permissions.

## Consequences

Restarting a Worker Codex thread reapplies its unattended policy, including
after permission changes made while it was running. The resume request still
targets the original thread and leaves model and reasoning recovery to Codex.
