# Agent Instructions

Instructions for agents working in this repository. Read applicable nested
`AGENTS.md` files before editing their directories. Explicit session instructions
take precedence.

## Scope and communication

- Discuss work with the user in Chinese.
- Write new or revised specifications in `docs/spec/` and design documents in
  `docs/design/` in Chinese, including headings and explanatory prose. Preserve
  the required spelling of code, commands, identifiers, paths, and API names.
- Always write specifications, solution proposals, architecture, design, and
  related documents stored in Daynight task descriptions or attachments in
  Chinese. Preserve the required spelling of code, commands, identifiers, paths,
  and API names.
- Write other repository documents, skills, code, comments, and commit messages
  in English unless explicitly instructed otherwise.
- Use the user's confirmed task and existing requirements to establish scope.
  A request to investigate or discuss remains read-only unless edits are
  authorized. Skills describe workflows and grant no additional permission.
- Manage this repository's tasks in Daynight, including task breakdowns,
  dependencies, execution status and task-specific plans and attachments. When
  `using-daynight` and Daynight are available, use Daynight to manage concrete
  work with a defined objective and completion conditions: features, bug fixes,
  architecture/design work, and actual work items produced by their breakdown.
  An agent's transient execution steps, such as reading files, running commands,
  and routine checks, belong in its execution plan; their presence in a plan does
  not make them Daynight tasks.
  All solution, architecture, and design reviews must use the owning Daynight
  task. Before requesting user review of such a discussion, save the complete
  current material in that task's description or
  attachments, read it back, and provide the task and resource reference.
  Synchronize revisions and review decisions there; chat summaries and repository
  or PR links supplement the saved material. This instruction authorizes creation
  of required tasks within the user's confirmed scope, without granting approval,
  execution, or delivery permission. Report actual availability or upload failures.
  Do not commit task-management files, including `*-tasks.md`, or add execution
  bookkeeping and task-tracking pointers to repository documents. Keep durable
  product requirements, architecture, decisions and validation methods in their
  document owners. Load the `using-daynight` skill before executing any task and
  follow its applicable workflow.
- For a Goal, first create or reuse only its requirements-discussion task and
  enter `in_progress` when the user requests that discussion. After the user
  confirms the requirements and asks to proceed, complete that task, then create
  and start the solution or architecture discussion task. Create the actual
  delivery subtasks and their dependencies only after the user confirms the
  solution. A request to start or advance a discussion authorizes setting that
  discussion task to `in_progress`; it grants no delivery-task execution permission. Discussion completion follows the confirmed Daynight material and
  phase acceptance. Repository delivery retains its own PR and merge requirements.
- Complete authorized work and its verification. Report observed results and
  material limitations; keep unverified assumptions distinct from evidence.
- Mainline pushes and PR merges require explicit user authorization. Follow the
  session's authorization for commits, branch pushes, and external comments.

## Repository and document ownership

The [README](README.md) owns repository status, documentation conventions, and
available validation commands. The client command toolkit belongs in
`packages/daynight/`, with review behavior owned by its `review` command module;
the independent Go service belongs in `packages/daynight-server/`. Use Node.js
24 LTS and pnpm 11.28.6 for the CLI; run `pnpm typecheck`, `pnpm test`, and
`pnpm build` as applicable. The server uses Go 1.27.2 and PostgreSQL 18.6. From
its module, run `bash scripts/check.sh` with `DAYNIGHT_TEST_DATABASE_URL` set to
an isolated PostgreSQL database. Its required gate includes build, vet, race,
go-cov and unrounded total statement coverage strictly greater than 90%. Add
tooling only within an authorized task.

| Location | Owner |
|---|---|
| `.agents/skills/` | Repository workflow skills |
| `.agents/notes/` | Decision history, alternatives, and consequences |
| `.agents/notes/README.md` | Note paths, format, lifecycle, and retention |

Requirements describe required outcomes. Design documents explain mechanisms
and the rationale needed to understand them. Notes hold detailed alternatives
and decision history. Create documents when needed and link to their owners
without duplicating explanations.

Rewrite edited documents as coherent wholes and synchronize related active
documents in the same change. Preserve historical statements about a decision's
original circumstances. Explicit archives remain immutable.

## Worktrees and collaboration

- Perform code, configuration, and documentation changes in one dedicated
  worktree under the repository's `.worktrees/` directory. Keep the primary
  checkout clean. One task shares one worktree and branch across its agents.
- Inspect existing work before changing files; preserve unrelated modifications.
  Define file ownership for workers and coordinate concurrent edits. Install
  dependencies once per task.
- Use research subagents for investigations and an independent subagent for
  code review. Delegate context-heavy implementation and validation with the
  task scope, permitted worktree, and required evidence.
- Use the task worktree's `.tmp/` for probes, clones, and generated evidence.
  Local scratch execution plans may use Git-ignored `docs/plans/`; persistent
  task content belongs in its owning Daynight description or explicitly referenced
  documents, with confirmation and delivery evidence located in that task. Keep temporary files inside the
  project and remove task-owned temporary resources after verification.
- Clean up task-owned services and probes, including resources left by failed
  subagents. Retain an unfinished worktree until its changes are delivered;
  remove it after authorized integration into the mainline.

## Decision workflow

A nontrivial change alters behavior, architecture, a shared contract, tooling,
verification strategy, a stored or exchanged format, or a decision worth
reconsidering. Purely mechanical or local changes are exempt from note creation.

1. Inspect existing mechanisms and relevant documents before choosing a design.
   Reassess the structure when repeated edge cases expose the same weakness.
2. For scope choices, use [scope-cut](.agents/skills/scope-cut/SKILL.md) to record
   deferral costs and constraints while preserving the confirmed delivery goal.
3. Use [agent-notes](.agents/skills/agent-notes/SKILL.md) to find an existing
   decision owner. Deliver nontrivial work with its implemented note, affected
   documents, and appropriate validation in the same change. Work being delivered
   goes directly into `implemented/`; substantive deferred work uses `proposed/`.
4. Preserve the original rationale when a decision changes. Write a new note
   and cross-link active records. Link from the replacement to an archived
   predecessor without editing that archive. Keep active statements of current
   facts synchronized with the implementation.

The [notes instructions](.agents/notes/AGENTS.md) govern that directory. Read-only
investigations stay read-only unless recording a proposal is authorized.

## Writing and review

- Use [prose-standard](.agents/skills/prose-standard/SKILL.md) to preserve
  obligations, conditions, ownership, failures, and essential rationale.
- Use [trim-cot-leakage](.agents/skills/trim-cot-leakage/SKILL.md) to remove
  session-only references and authoring narration while preserving durable facts.
- Comments explain non-obvious decisions and invariants in the system author's
  voice. Cite durable references, using commit-pinned links for GitHub sources.
- Review within the declared task or PR scope. Prove that Critical or Major
  findings are introduced by the change and show their caller-visible effect.
  Defer smaller or unrelated improvements. When publishing PR findings, identify
  the agent and place English comments on the relevant changed lines.
- Keep fixes within the original delivery goal. A PR's review cycle must not
  accumulate unrelated cleanup.

## Validation and delivery

Choose checks from the actual files and tooling involved. For skill and document
changes, validate frontmatter, local links, lifecycle/path agreement, mandatory
note sections, and skill discovery. Check newly created files as well as
`git diff --check`; Git does not include untracked files in an ordinary diff.

For code changes, verify observable behavior and relevant failure paths using
the repository's documented commands. Preserve acceptance criteria and expose
errors. Run meaningful coverage checks when coverage tooling exists; a green
check alone does not prove backend, lifecycle, concurrency, or browser behavior.

Diagnose a failing check before retrying. Repeat an unchanged failure only after
confirming a transient infrastructure cause. Add time bounds to commands that
may hang and keep output streaming. Summarize actual checks and their limits.

Preserve task scope when staging and committing; use the repository's commit
conventions and default Git identity. Omit AI tool co-author attribution. Keep
work-branch history and integrate mainline updates by merge when needed. For an
authorized PR merge, require real successful checks and a linear mainline.

## Discovery

`.agents/skills/` is canonical. `CLAUDE.md` links to this file;
`.claude/skills` and `.claude/worktrees` link to the shared skill and worktree
directories. Keep these relative links intact so tools use the same workflow.
When updating `using-daynight`, modify only its source under
`packages/daynight/src/commands/skill/skills/using-daynight/`. Do not edit installed
copies. `daynight update` refreshes existing User and current-worktree Project
copies automatically. For first installation or copies in other projects, run
`daynight skill install` for the relevant Agents and scopes, then follow the
reload instructions.

