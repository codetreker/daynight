---
name: handoff-goal
description: Hand all unfinished tasks in a user-specified Daynight task group off to agents.
---

# Handoff Goal

Use the [using-daynight skill](../../../packages/daynight/src/commands/skill/skills/using-daynight/SKILL.md)
to identify all unfinished tasks in the user-specified task group and apply its
handoff workflow to each task. Preserve each task's state-specific handling:
proposed tasks keep their status and permission unless the caller explicitly
selects todo, and enabling allowAgents alone cannot make them eligible for
automatic execution.
