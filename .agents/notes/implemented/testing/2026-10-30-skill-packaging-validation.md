# Agent Note: Skill Packaging Validation

Status: implemented

## Problem

Correctly packaged skill resources can fail static assertions when their wording
or headings change without altering the intended instructions. These checks
couple instruction prose to test patterns and do not establish that an agent
understands or follows the skill.

## Decision

Skill automation validates packaging, not instruction text contracts. The existing
[resource inspection fixture](../../../../packages/daynight/test/fixtures/skill-contract.ts)
and [copy tests](../../../../packages/daynight/test/tooling/copy-skills.test.ts)
validate resource inventory, allowlisted bundles, YAML entrypoint metadata,
local links contained within the bundle and byte-for-byte copying. The existing
[skill installation acceptance](../../../../packages/daynight/test/cli/skill.acceptance.ts)
uses the actual packed CLI in an isolated installation and compares packaged
resources with source resources and installed copies. Existing installation,
replacement, migration and cleanup coverage remains in place.

The structured receipt records `skillBundle.metadata` and `skillBundle.resources`,
including resource paths, SHA-256 digests and local references. These are
packaging observations, not instruction contracts or instruction-scenario
outcomes; installation scenarios remain installation evidence. There are no
assertions about instructional rules, sections or wording, and no instruction-text
mutation tests. Packaging success does not establish model understanding or
compliance.

This partially supersedes the skill text-contract verification claims in the
[cross-layer acceptance decision](2026-10-22-task-lifecycle-cross-layer-acceptance.md),
[task/session content decision](../process/2026-10-28-task-session-content.md),
[task handoff decision](../process/2026-10-25-task-content-handoff.md),
[worker-managed completion decision](../architecture/2026-10-26-worker-managed-completion.md)
and [task approval lifecycle decision](../feature/2026-10-22-task-approval-lifecycle.md).
Their functional decisions and original delivery history remain intact.

## Alternatives

**Retain or update text-contract checks.** This was considered while repairing
the failed checks, but even updated patterns would keep wording and headings tied
to static assertions without establishing instruction compliance. Packaging
checks retain observable guarantees without constraining prose, so text-contract
checks are removed.

## Consequences

Missing resources, invalid metadata or links, disallowed bundle inclusion and
byte mismatches remain detectable through the existing packaging validation.
Instruction semantics are not claimed as tested. Independent semantic review
remains separate from automated packaging checks; it is not an automated
contract or a guarantee of model behavior.
