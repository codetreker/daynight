---
name: handoff-goal
description: Hand unfinished direct Task children of a user-specified Daynight Goal off to agents.
---

# Handoff Goal

Read the specified `type=goal` resource, then enumerate its ordinary direct children by Parent, including every page; an empty Goal has no Tasks to hand off. Apply the [handoff workflow](../development-workflow/references/handoff.md) to each unfinished child individually, checking its actual Parent, assignee, `allowAgents`, status, platform, dependencies and required sources. Membership does not follow dependency connectivity: do not include cross-Goal or unparented dependencies. The Goal owner does not grant authority to change another user’s Task.

Proposed Tasks retain their status and permission unless the caller explicitly selects todo; enabling `allowAgents` alone does not make them eligible for automatic execution. Do not hand off the Goal itself or infer a Goal from an old `[Goal]` title.
