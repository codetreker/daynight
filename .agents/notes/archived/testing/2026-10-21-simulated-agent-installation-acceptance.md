# Agent Note: Skill installation acceptance with simulated Agents

Status: implemented

## Problem

The public skill installer discovers supported launchers and writes a packaged
directory tree. Its acceptance must distinguish incorrect paths, missing bundle
resources and incomplete replacement from unrelated Agent authentication,
provider availability and model behavior. Requiring live Agent execution makes
file installation depend on systems the installer never invokes.

## Decision

Acceptance runs the actual packed and locally installed CLI against isolated
homes, Git worktrees and PATH directories. Fake `codex`, `copilot` and `claude`
launchers represent installed Agents. Each leaves an execution marker and fails
if invoked; acceptance requires that marker to remain absent.

The existing terminal fixture drives Agent and scope selection through real
PTY/ConPTY input. A three-Agent by two-scope matrix compares each destination's
complete files with the packaged bundle, then repeats installation after local
edits and obsolete files are added. Sibling skills and an existing installation
at the opposite scope remain unchanged. Existing cases cover shared targets,
parent links, linked worktrees, unavailable Agents and cancellation. Migration
cases publish using-daynight before removing the legacy daynight leaf, preserve
other scopes and link targets, and report cleanup failures with the new bundle
still installed.

Static checks preserve using-daynight frontmatter, the ordinary and managed mode
references, neutral task-execution guidance, shared task-content standard and
Goal protocol. They check explicit worker mode routing, separate lifecycle
instructions, content-aware registration and handoff, observed-version updates
and merge-bound completion. The
[managed execution decision](../../implemented/architecture/2026-10-26-managed-task-skill.md)
owns the current resource separation and autopilot removal. The [mode decision](../architecture/2026-10-21-using-daynight-modes.md)
owns routing and legacy-name migration; the
[Goal decision](../../implemented/process/2026-10-22-goal-workflow-design.md) owns stage rules,
stage-specific task content and shared-source ownership. The
[task-content and handoff decision](../../implemented/process/2026-10-25-task-content-handoff.md)
owns the current six-item standard and reviewed permission enablement. Independent scenario review
assesses routing and workflow meaning separately from file installation. Existing task-command tests own those commands' executable contracts.
Agent installation, login, runtime execution and model behavior are outside
this installer's acceptance boundary.

This replaces the live-loading acceptance requirement in the
[public skill design decision](../architecture/2026-10-21-public-agent-skill-design.md).
The [terminal acceptance decision](2026-10-21-native-skill-terminal-acceptance.md)
continues to own native terminal and filesystem evidence.

## Alternatives

**Run actual Agents and models.** This tests host discovery, provider routing
and instruction following, but adds credentials, service dependencies and
nondeterministic behavior unrelated to the installer's file operations.

**Test only internal copy functions.** This misses the installed npm launcher,
interactive selection, scope resolution and complete published bundle. The
existing installed CLI fixture exercises those boundaries without launching
Agent programs.

## Consequences

Installation acceptance is deterministic and runs in the existing Linux,
macOS and Windows CLI jobs. It requires no installed Agent or model credentials.
Its receipts establish the packaged files and installer behavior at the tested
source; they do not claim that a particular Agent or model follows the skill.
