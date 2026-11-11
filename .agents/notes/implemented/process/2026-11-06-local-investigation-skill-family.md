# Agent Note: Local Investigation Skill Family

Status: implemented

## Problem

The local environment skill also carried the UI audit method, finding packages
and production handoff. Every investigation needs the environment, but the
questions differ by topic. A UI audit judges layout and interaction; a
performance investigation needs controlled measurement; a competitor comparison
produces requirement candidates for the Goal requirements discussion rather than
delivery tasks. Topic-specific requirements in a shared skill spread to unrelated
work: a finding about CLI output or a Provider's data projection still had to
carry a UI prototype. Each new topic would also enlarge the environment skill's
entry point and trigger description.

Lessons from real runs mixed environment knowledge, such as operating controller
Test Sessions or sharing the environment with other agents, with topic judgment,
such as which layouts count as findings. Without separate owners, these lessons
had no clear place, and the environment skill grew with every investigation.

## Decision

Three repository skills divide the responsibilities:

- [prepare-daynight-local](../../../skills/prepare-daynight-local/SKILL.md)
  operates the local environment: preparation, refresh, verification, test
  identities, test-repository routing, website operation, the managed Worker
  loop, controller Test Sessions, local fixtures, observation tools including the
  consistent-capture helper, and the rules for sharing the environment with
  other agents.
- [discover-daynight-improvements](../../../skills/discover-daynight-improvements/SKILL.md)
  holds the contract shared by every investigation topic: authorization
  boundaries, coverage records, the evidence standard with freshness checks and
  private-data screening, classification, the finding package and its validator,
  routing to the development workflow for task creation and handoff or the Goal
  protocol, read-only review of registered tasks against their packages, and
  closing the loop after delivery.
- [audit-daynight-ui](../../../skills/audit-daynight-ui/SKILL.md) is the first
  topic skill. It owns UI finding criteria including unreasonable layout, default
  phone and desktop coverage, the Session View checklist, designed solutions with
  interactive prototypes, and the prototype checker.

Further topic skills, such as performance or competitor research, are created
when a real investigation first needs one, from the reusable parts of that run.
Until then, the contract alone governs such an investigation and the run reports
the missing method.

The finding package format `daynight-finding-v1` makes the prototype optional;
the topic skill decides when one is required. Packages in the earlier
`daynight-ui-finding-v1` format remain valid with their mandatory prototype. The
validator can scan text files for supplied private strings and lists binary files
that need visual review.

The capture helper stays in the environment skill with its existing path, because
implementers also use it to verify delivered UI fixes outside any investigation.

The [local development environment decision](2026-11-05-local-development-environment-skill.md)
keeps its environment rationale. This note replaces its placement of the
experience audit inside the environment skill. The [small-change skill removal
decision](2026-11-11-remove-small-change-skill.md) replaces the original routing
through the independent dispatcher with the existing development workflow.

## Alternatives

**Keep one skill and add references.** This changes the fewest files, but the
environment and every investigation topic would still share one trigger
description and one entry point. Topic requirements, such as mandatory
prototypes, would keep applying to unrelated topics, and the entry routing would
grow with each topic.

**Split topic skills without a shared contract.** The boundaries, evidence
standard, package and handoff rules would be repeated in each topic skill or
written by the first one in its own terms. The UI-specific prototype requirement
reaching CLI and Provider findings showed this failure.

**Put the shared contract into the small-change dispatcher.** At the time, that
skill registered and handed off one bounded change. It did not cover coverage
records, evidence standards across many findings, or requirement candidates that
belong to the Goal protocol. Keeping its scope and referencing it from the
contract avoided widening a skill that other workflows used for ordinary changes.

**Create performance and competitor skills now.** Without a real run, their
methods could not be checked against actual failures. Creating each one from its
first real investigation keeps them grounded and lets that run test the skill.

**Move the capture helper into the UI skill.** Implementers verifying delivered
UI fixes use the helper outside an investigation. Moving it would break that use
and tie a general observation tool to one topic.

## Consequences

An environment request loads only the environment skill. An investigation loads
the contract, one topic skill and the environment references it needs. Topic
requirements no longer constrain other topics, and a new topic adds a skill
instead of enlarging the environment entry point.

Three entry points must keep consistent descriptions, so that investigation
requests load the contract and environment requests do not. Cross-skill links
assume the skills are installed side by side. Links into repository documents
resolve from a Daynight checkout, so a user-level installation outside a
checkout needs a checkout to resolve them. The private-string scan covers text
files only; images and PDFs still need visual review. Investigations of topics
without a skill rely on the contract alone until such a skill exists.
