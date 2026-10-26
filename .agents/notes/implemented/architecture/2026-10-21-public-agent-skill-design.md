# Agent Note: Public project and task skill distribution

Status: implemented

## Problem

Agents can already operate Daynight project and task commands, but npm consumers
have no distributed guidance for recovering project context and maintaining tasks
during development. The repository's own workflow skills are not product assets.
The internal review skill is loaded by the review runtime and does not provide a
user installation flow for general-purpose agents.

## Decision

The original distribution decision introduced one portable `daynight` skill
and an interactive `daynight skill install` command. The
[mode and attachment decision](2026-10-21-using-daynight-modes.md) partially
supersedes its public name and task-protocol ownership. The current bundle is
`using-daynight` under `src/commands/skill/skills/using-daynight/`, with an
entrypoint, ordinary and managed execution references, neutral task-execution
guidance, shared task-content standard and the
[shared Goal protocol](../process/2026-10-22-goal-workflow-design.md). The
[requirements](../../../../docs/spec/daynight-agent-skill.md) and
[design](../../../../docs/design/daynight-agent-skill.md) own the current contract.
The original design task required a merged PR and satisfied acceptance; document
preparation and review alone did not complete it.

The installer detects Codex, Copilot CLI and Claude Code launchers, asks which
agents to install for, then asks for user or project scope. It replaces the whole
selected using-daynight directory with packaged bytes, then removes the legacy
daynight leaf in the same selected physical root. It does not preserve local
edits or introduce an installation registry. The later
[installed-skill update decision](../feature/2026-10-24-update-installed-agent-skills.md)
adds automatic refresh during `daynight update` for existing User and
current-worktree Project copies, while preserving interactive first installation.
Codex and Copilot share their
`.agents/skills` destination; Claude uses `.claude/skills`. Parent links are
preserved, physical targets are deduplicated and destructive nested targets are
rejected before writes. Selected agents can share discovery with unselected
agents. The replacement note owns migration ordering and partial-cleanup results.

The original workflow taught active task management in associated repositories,
including fresh worktrees. The
[bounded-selection decision](../feature/2026-10-21-bounded-ready-task-selection.md)
replaced its graph-first recovery policy with bounded ready queries, while
preserving show for full details and graph or complete lists when needed.
Selecting one task most related to authorized work and retaining it through
CI/review/merge waits prevented candidates from becoming an implicit batch.
The replacement mode decision originally assigned next-work selection to
explicitly requested autopilot and designated-task completion to run-task. The
[managed execution decision](2026-10-26-managed-task-skill.md) removes that
agent-side scheduling mode and separates ordinary execution from explicitly
worker-selected managed instructions. Observed versions and readiness without
ownership remain required. The later
[status assignment decision](2026-10-24-task-status-assignment.md) replaces the
historical approval actions with todo registration and versioned set-status.
Registration does not execute work. Ordinary execution handles one specified
task and managed execution handles one assigned claim; automatic worker
discovery still requires its permission and eligibility checks. Existing
authorization remains separate from the skill's control over task selection.
Execution and delivery permission boundaries remain independent of state.

Development and PR-delivered design/documentation tasks remain in progress while
necessary PRs are open. All required PRs must be platform-confirmed merged and
acceptance satisfied before done. PR URLs/titles remain in properties; the
replacement decision originally moved acceptance evidence and merge commits to the
primary Markdown attachment and progress to existing checkpoints. The later
[task-content and handoff decision](../process/2026-10-25-task-content-handoff.md)
allows a designated task-body or attachment evidence location while retaining
separate operational checkpoints. Non-PR tasks use their
explicit acceptance criteria. No completion rule supplies merge authority.

The [installation acceptance decision](../testing/2026-10-21-simulated-agent-installation-acceptance.md)
replaced the original live-loading acceptance requirement with packed-CLI tests
using simulated launchers, real PTY/ConPTY and complete file comparisons. Static
checks inspect distributed guidance; independent scenario review assesses mode
instructions separately from installer file evidence.

The [bundled review decision](2026-10-20-bundled-review-skill.md) continues to own
review snapshots and Copilot invocation. Its original narrow runtime scope does
not become a general user installation mechanism. The product skill gets its own
command owner and may share only genuinely common data-level bundle validation.
The build copier uses an explicit allowlist for both complete bundles, retains
exclusive destination creation, and does not publish repository workflow skills.
The public bundle is ordinary packaged data; this step adds no installation
side effects or review-runtime dependency.

## Alternatives

**Copy the packaged bundle.** Adopted because the installed skill survives npm
path changes and temporary `npx` cleanup. Explicit reinstall updates it, and
whole-directory replacement removes obsolete references.

**Link directly into the npm installation.** Codex and Claude support linked
skills, but package removal or relocation can break the installed link. Windows
link creation adds environmental requirements. This does not satisfy independent
installed-resource lifetime as predictably as copying.

**Package a plugin for each agent.** Agent plugins are real distribution options,
and review already needs a Copilot plugin wrapper. This one portable skill needs
neither per-host manifests nor plugin registration, so those mechanisms add
installation state and do not resolve cross-root duplicate discovery by
themselves.

**Preserve edited installations.** This would require ownership metadata, edit
detection or merging. The chosen product behavior is unconditional replacement;
the same command installs and refreshes current packaged content.

**Build terminal key handling or use numbered text questions.** Custom raw-mode
handling adds terminal lifecycle code, while text-number parsing does not provide
checkbox selection. A lazy-loaded maintained checkbox/select implementation
fits the requested interaction while retaining existing setup text prompts.

**Add task ownership and other project fields with the skill.** The existing
task model already supports this workflow through dependencies and optimistic
versions. At the original decision, ownership, comments, priorities and attachments were
separate service-contract changes. Attachment-backed task planning is now owned
by the replacement mode decision; no exclusive claim is inferred from
`in_progress`.

## Consequences

Installation is independent of server and review configuration. A small fixed
Agent catalog owns directories and reload guidance. Acceptance simulates installed
launchers and proves detection never executes them, then verifies all six Agent
and scope destinations with the actual packaged CLI. Complete bundle bytes,
direct replacement, stale-file removal and preservation of sibling skills and
the opposite scope are observable installer results. A selection expresses
compatibility rather than exclusive visibility to that Agent.

Whole-directory replacement can discard local customization. Without backups,
a filesystem failure after removal can leave a target absent; completed earlier
targets remain installed and the command reports the partial result. Legacy-name
cleanup failure preserves the newly published bundle and reports migration as
incomplete. Re-running restores current packaged content. The original
distribution decision left npm-to-skill synchronization manual; the later
installed-skill update decision adds bounded automatic synchronization.
Cross-target transactions, rollback and edit merging remain outside the
replacement mechanism.

An open delivery PR keeps its task in progress and its implementation successors
blocked. Installer acceptance does not require real Agent installation, account
configuration, models, or a Daynight service/database; existing task tests own
the task-command semantics. Implementation readiness does not itself grant
authorization to execute that work.
