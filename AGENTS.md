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
- Write the confirmed server organization rules in `docs/daynight-server.md` in
  Chinese. Write other repository documents, skills, code, comments, and commit
  messages in English unless explicitly instructed otherwise.
- Use the user's confirmed task and existing requirements to establish scope.
  A request to investigate or discuss remains read-only unless edits are
  authorized. Skills describe workflows and grant no additional permission.
- Manage this repository's tasks in Daynight, including task breakdowns,
  dependencies, execution status, task definitions, inputs, and resulting
  artifacts. When `using-daynight` and Daynight are available, use Daynight to manage concrete
  work with a defined objective and completion conditions: features, bug fixes,
  architecture/design work, and actual work items produced by their breakdown.
  An agent's transient execution steps, such as reading files, running commands,
  and routine checks, belong in its session execution plan; their presence in a
  plan does not make them Daynight tasks or task material.
  All solution, architecture, and design reviews must use the owning Daynight
  task. Before requesting user review of such a discussion, save the complete
  current material in that task's description or
  attachments, read it back, and provide the task and resource reference.
  Synchronize the current requirements, design, and resulting decisions there;
  discussion methods, review process, and operational authorization stay in the
  session. Chat summaries and repository or PR links supplement the saved
  material. This instruction authorizes creation of required tasks within the user's confirmed scope, without granting approval,
  execution, or delivery permission. Report actual availability or upload failures.
  Do not commit task-management files, including `*-tasks.md`, or add execution
  bookkeeping and task-tracking pointers to repository documents. Keep durable
  product requirements, architecture, decisions and validation methods in their
  document owners. Use the `using-daynight` manual for Daynight product operations; follow the
  [development workflow](.agents/skills/development-workflow/SKILL.md) for
  repository work and its applicable task procedures.
- For a Goal, first create or reuse only its requirements-discussion task and
  enter `in_progress` when the user requests that discussion. After the user
  confirms the complete uploaded `spec.md` and asks to proceed, create or reuse
  and read back the solution or architecture discussion task with an ordinary
  dependency on the still-in-progress requirements task. Complete and verify the
  requirements task before starting that successor discussion. Create the actual
  delivery subtasks and their dependencies only after the user confirms the
  solution. A request to start or advance a discussion authorizes setting that
  discussion task to `in_progress`; it grants no delivery-task execution permission. Discussion completion follows the confirmed Daynight material and
  phase acceptance. Repository delivery retains its own PR and merge requirements.
- Complete authorized work and its verification. Before marking a task done,
  verify both its own results and the actual registration of any required
  successors within its confirmed scope and existing creation authorization.
  Registration does not start successor execution; terminal tasks need no
  invented successor. Report observed results and material limitations; keep
  unverified assumptions distinct from evidence.
- Mainline pushes and PR merges require explicit user authorization. Follow the
  session's authorization for commits, branch pushes, and external comments.

## Repository and document ownership

The [README](README.md) owns repository status, documentation conventions, and
available validation commands. The client command toolkit belongs in
`packages/daynight/`, with review behavior owned by its `review` command module;
the independent Go service belongs in `packages/daynight-server/`. Use Node.js
24 LTS and pnpm 11.28.6 for the CLI; run `pnpm typecheck`, `pnpm test`, and
`pnpm build` as applicable. The server uses Go 1.27.2 and PostgreSQL 18.6. From
its module, run `bash scripts/check.sh` and `bash scripts/startup-shutdown.sh`
with `DAYNIGHT_TEST_DATABASE_URL` set to an isolated PostgreSQL database. The
module and command-lifecycle coverage partitions both require build, vet, go-cov
and unrounded statement coverage strictly greater than 90%; together they cover
every production package. Race instrumentation is enabled for local validation and main CI; PR CI disables it
through the explicit [race policy](packages/daynight-server/README.md#race-instrumentation).
Add tooling only within an authorized task.

| Location | Owner |
|---|---|
| `.agents/skills/` | Repository workflow skills |
| `.agents/notes/` | Decision history, alternatives, and consequences |
| `.agents/notes/README.md` | Note paths, format, lifecycle, and retention |

Requirements describe required outcomes. Design documents explain mechanisms
and the rationale needed to understand them. Notes hold detailed alternatives
and decision history. Create documents when needed and link to their owners
without duplicating explanations.

Ship ordinary documentation with its corresponding implementation code in the
same PR. Open a standalone documentation PR only with explicit user permission;
permission for one document does not authorize publishing other documents.

Mock UI and interactive prototype artifacts belong in the owning Daynight task
attachments. Never commit or push UI mockups, `mockui` pages, their resource
bundles, generated previews, or tests that target them; never include them in a
repository PR or place them in product or source directories. This includes
interactive previews composed from production components. Keep local inspection
copies only in the task worktree's Git-ignored `.tmp/`, remove them after use,
and save reviewable prototypes as attachments of their owning Daynight task.

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
  Local scratch execution plans may use Git-ignored `docs/plans/`. Task
  definitions, required inputs, deliverables, acceptance criteria, and results
  belong in the owning Daynight description or referenced documents. Execution
  and discussion plans, tool choices, collaboration, operational authorization,
  progress, blockers, and recovery context stay in the session or its local
  checkpoint. This boundary applies to descriptions, attachments, and referenced
  task material. Keep temporary files inside the project and remove task-owned
  temporary resources after verification.
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

- Read and follow the [server code organization rules](docs/daynight-server.md)
  before adding to, modifying, or reviewing daynight-server.
- Follow the [UI design principles](docs/ui-design.md) when designing, adding,
  modifying, or reviewing UI.
- Read and follow the [test-writing rules](docs/writing_tests.md) before adding,
  modifying, or reviewing tests. Use them to establish test ownership, dependency
  isolation, integration scope, CI selection and resource cleanup.
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

Ordinary change PRs must leave `packages/daynight/package.json` version unchanged.
Use the [release-daynight skill](.agents/skills/release-daynight/SKILL.md) for
version selection, any version PR, and the complete CLI publication and
verification workflow.

Choose checks from the actual files and tooling involved. For skill and document
changes, validate frontmatter, local links, lifecycle/path agreement, mandatory
note sections, and skill discovery. Check newly created files as well as
`git diff --check`; Git does not include untracked files in an ordinary diff.

For code changes, verify observable behavior and relevant failure paths using
the repository's documented commands. Preserve acceptance criteria and expose
errors. Run meaningful coverage checks when coverage tooling exists; a green
check alone does not prove backend, lifecycle, concurrency, or browser behavior.
CI unit, integration, and other routine test suites must not run stress-test
cases. Run stress tests separately from these CI suites: slower CI runners make
these cases expensive and delay PR delivery across the repository.

Inspect failure logs before retrying. Each failed check on the same commit may
be rerun at most twice beyond its initial run, without first proving a transient
infrastructure cause. Count retries across sessions, restarts and workflow
reruns. If both retries fail, diagnose and repair the cause before further
validation. A passing retry does not establish the root cause or relax required
checks and acceptance criteria. Add time bounds to commands that may hang, keep
output streaming, and report retries, observed results and their limits.

Preserve task scope when staging and committing; use the repository's commit
conventions and default Git identity. Omit AI tool co-author attribution. Keep
work-branch history. When a PR has no merge conflicts with `main`, leave its work
branch unchanged; do not merge `main` merely to bring the branch up to date. Merge
`main` into the work branch only to resolve conflicts, within the task worktree.
For an authorized PR merge, require real successful checks and a linear mainline.

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

