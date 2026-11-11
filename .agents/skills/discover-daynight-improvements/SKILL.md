---
name: discover-daynight-improvements
description: Use when asked to find problems, improvement opportunities or requirement candidates in Daynight — UI and usability, performance, competitor comparison or another topic — and to turn confirmed findings into Daynight work. Not for implementing an already-defined change or for operating the local environment itself.
---

# Discover Daynight Improvements

Investigate Daynight through real use, confirm each finding with evidence and
register every independently actionable result as Daynight work. This skill is
the contract shared by all investigation topics. A topic skill supplies what to
examine and how to judge it. [prepare-daynight-local](../prepare-daynight-local/SKILL.md)
supplies the local environment, browser identity, controller Test Sessions and
observation tools. Registration and handoff follow the
[development workflow](../development-workflow/SKILL.md) and the `using-daynight`
manual for product operations.

Links that leave the skills directory refer to the Daynight repository. When
these skills are installed outside a checkout, resolve such links against the
selected Daynight source checkout.

## Choose the topic skill

Load the topic skill before exploring. Keep findings from different topics
separate even when one investigation covers several.

| Topic | Method |
| --- | --- |
| UI, usability, layout, interaction, accessibility, language, Session View | [audit-daynight-ui](../audit-daynight-ui/SKILL.md) |
| Performance, latency or resource use | No topic skill exists yet. Agree on scenarios and measurement with the user, follow this contract and report the missing method |
| Competitor comparison or requirement discovery | No topic skill exists yet. Results are requirement candidates for the Goal requirements discussion, not delivery tasks |
| Another topic | Follow this contract and report the missing topic method |

After a run without a topic skill, propose one built from the reusable parts of
that run. Create it only within an authorized skill change.

## Keep the boundaries

- Investigation does not change production data. Local fixtures and Test
  Sessions follow prepare-daynight-local in the selected local environment.
- Registering findings in production requires the user's authorization for this
  investigation. Enabling automatic execution is a separate authorization.
- The investigator registers and hands off findings; Workers or the user own
  delivery. Do not implement findings, commit, push or open PRs for them unless
  the user explicitly asks for that implementation.
- Keep the investigation's own steps, logs and coordination in the session or a
  private local record. Findings become tasks; the investigation process does
  not.
- Follow the user's stated granularity. Without one, use one independently
  actionable improvement per task, at the level of one component or one behavior.

## Work through the investigation

1. **Frame** the user goals, topic, scope, authorized outputs, and the source and
   environment identity. Fetch the target revision and record its full SHA.
2. **Plan coverage** as a small table of user goals, states and conditions, and
   record skipped cells. See [the method](references/method.md).
3. **Explore** real paths and record candidates with a minimal reproduction.
4. **Confirm** each candidate with evidence that meets
   [the evidence standard](references/evidence.md). Inspect the relevant source
   before naming a cause; keep observations and inferences separate.
5. **Classify** each candidate as an improvement, expected behavior, environment
   or tooling failure, duplicate, or out of scope. Record the reason for every
   exclusion.
6. **Package** each improvement as [one finding package](references/finding-package.md),
   including the design material the topic skill requires. Screen every artifact
   for private data before validation.
7. **Recheck freshness** against the latest target revision before dispatch.
8. **Dispatch** each finding through [the handoff procedure](references/handoff.md).
9. **Report** findings with task links, exclusions and reasons, untested layers,
   environment limitations and retained resources.
10. **Close the loop** when retesting is in scope: replay the original failure on
    the delivered revision, and feed reusable lessons back into the topic skill.

## Route each finding

| Finding | Route |
| --- | --- |
| A bounded change with clear target behavior | One task through the [development workflow](../development-workflow/SKILL.md), with the package attachments |
| A clear required outcome whose cause is unknown | One task that states the investigation responsibility and observable acceptance |
| A new capability, product direction or competitor-derived requirement | The `development-workflow` Goal protocol, starting with a requirements discussion when the user requests it |
| A failure of the local environment, browser automation or a Provider account | Report it; repair it under prepare-daynight-local when authorized, not as a product task |
| A problem in a skill or repository workflow | A task owned by that workflow, not a product task |

Report registration, content verification, permission enablement, claims and
completion as different outcomes. `allowAgents=true` permits scheduling; it is
neither a claim nor a delivered fix.
