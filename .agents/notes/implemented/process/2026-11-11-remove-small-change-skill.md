# Agent Note: Remove the Small-Change Dispatch Skill

Status: implemented

## Problem

A separate repository skill routed bounded changes through task preparation and
handoff even though the development workflow already owns task creation, content,
platform selection and handoff. Maintaining two entry points for the same work
risks inconsistent instructions, while investigation findings still need their
own evidence and package requirements.

## Decision

The repository no longer exposes a dedicated small-change dispatch skill. The
[development workflow](../../../skills/development-workflow/SKILL.md) owns task
preparation and handoff, and the `using-daynight` manual owns product operations.
[Investigation handoff](../../../skills/discover-daynight-improvements/references/handoff.md)
retains its finding package, evidence, production context and readback rules.

This replaces the dispatcher routing in the active [investigation skill family
decision](2026-11-06-local-investigation-skill-family.md). The archived
[small-change dispatch decision](../../archived/process/2026-11-04-small-change-dispatch.md)
records why the separate entry point was originally adopted.

## Alternatives

**Retain the dedicated dispatcher.** It provides a bounded-change entry point,
but duplicates responsibilities already owned by the development workflow and
requires both routes to stay synchronized.

**Remove the skill without migrating its routes.** This leaves broken links and
no clear route for registering and handing off investigation findings.

## Consequences

Ordinary changes and confirmed investigation findings use the same task creation
and handoff owners. Investigations still apply their additional evidence and
package checks. Readers must follow the development workflow and product manual
for the detailed operations; there is no separate bounded-change entry point.
