---
name: handoff-task
description: Hand a user-specified Daynight task off to an agent.
---

# Handoff Task

Use the [using-daynight skill](../../../packages/daynight/src/commands/skill/skills/using-daynight/SKILL.md)
to hand the user-specified task off to an agent, following its state-specific
handling. Proposed tasks retain their status and permission unless the caller
explicitly selects todo; enabling allowAgents alone does not make them eligible
for automatic execution.
