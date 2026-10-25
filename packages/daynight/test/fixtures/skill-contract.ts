import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

type Resource = { readonly path: string; readonly sha256: string; readonly localReferences: readonly string[] };
export type InstalledSkillContract = {
  readonly documents: ReadonlyMap<string, string>;
  readonly resources: readonly Resource[];
  readonly metadata: { readonly name: string; readonly description: string };
};

const prose = (content: string): string => {
  let fence: { marker: string; length: number } | undefined;
  return content.split(/\r?\n/).filter((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = { marker: marker[0]!, length: marker.length };
      else if (marker[0] === fence.marker && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      return false;
    }
    return fence === undefined;
  }).join("\n");
};
const contained = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export const inspectInstalledSkill = async (directory: string): Promise<InstalledSkillContract> => {
  const root = await realpath(directory);
  const documents = new Map<string, string>();
  const resources: Resource[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) { await visit(file); continue; }
      const relative = path.relative(root, file).replaceAll("\\", "/");
      const bytes = await readFile(file);
      const localReferences: string[] = [];
      if (entry.name.endsWith(".md")) {
        const content = bytes.toString("utf8");
        documents.set(relative, content);
        for (const match of prose(content).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
          const target = match[1]!;
          if (target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
          const resource = path.resolve(path.dirname(file), target.split("#")[0]!);
          assert.ok(contained(root, resource), `${relative} links outside the installed bundle: ${target}`);
          assert.ok(contained(root, await realpath(resource)), `${relative} resolves outside the installed bundle: ${target}`);
          localReferences.push(target);
        }
      }
      resources.push({ path: relative, sha256: createHash("sha256").update(bytes).digest("hex"), localReferences });
    }
  };
  await visit(root);
  resources.sort((left, right) => left.path.localeCompare(right.path));
  for (const resource of [
    "SKILL.md", "references/handbook.md", "references/create-task.md", "references/run-task.md",
    "references/autopilot.md", "references/goal.md", "references/task-content.md", "references/handoff.md",
  ]) assert.ok(documents.has(resource), `The installed bundle contains ${resource}.`);
  const entrypoint = documents.get("SKILL.md");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(entrypoint!);
  assert.notEqual(frontmatter, null, "The installed skill has YAML frontmatter.");
  const metadata: unknown = parseYaml(frontmatter![1]!);
  assert.ok(typeof metadata === "object" && metadata !== null && !Array.isArray(metadata));
  assert.ok("name" in metadata && metadata.name === "using-daynight");
  assert.ok("description" in metadata && typeof metadata.description === "string" && metadata.description.trim().length > 0);
  return { documents, resources, metadata: { name: metadata.name, description: metadata.description } };
};

type Proposition = { readonly resource: string; readonly section: string; readonly requires: readonly RegExp[] };
type InstructionScenario = {
  readonly id: string;
  readonly input: string;
  readonly obligation: string;
  readonly propositions: readonly Proposition[];
};

export const instructionScenarios: readonly InstructionScenario[] = [
  {
    id: "automatic-selection-permission",
    input: "Automatic selection is active; a user may also explicitly select a task without automatic permission.",
    obligation: "Filter automatic candidates before pagination, never self-enable permission, and preserve explicit manual execution.",
    propositions: [
      { resource: "references/autopilot.md", section: "## Select one related task", requires: [/daynight task ready --allow-agents true --compatible-platform <actual-platform> --json/, /task with `allowAgents=true`/, /daynight task list --allow-agents true --compatible-platform <actual-platform> --json/, /Automatic selection never enables `allowAgents`/, /manual execution path remains available regardless of the flag/] },
      { resource: "references/run-task.md", section: "## Establish the task and stage", requires: [/explicitly user-selected task may use the manual execution path regardless of `allowAgents`/, /Automated task selection requires true and must not enable the flag itself/] },
      { resource: "references/handbook.md", section: "**Automatic execution permission.**", requires: [/New tasks start false/, /Actual changes are locked during in_progress/, /server combines that condition with other filters before pagination and the ready limit/, /Automatic selection requires true and does not enable permission itself/] },
    ],
  },
  {
    id: "automatic-selection-platform",
    input: "A Linux autopilot sees Windows-only tasks, a bounded page, or changed eligibility; a user may explicitly assign a fixed queue.",
    obligation: "Use actual-runtime server filters, retain automatic context and recheck full-task eligibility at the exact start version; preserve only explicit manual assignment exceptions.",
    propositions: [
      { resource: "SKILL.md", section: "## Shared constraints", requires: [/Automatic task selection requires `allowAgents=true`, readiness, and `requiredPlatform` compatibility with the actual current execution environment/, /filter both ready and supplemental inventory before pagination/, /carry automatic selection and its platform into run-task/, /Only an explicitly user-selected task or fixed Goal queue may follow the manual execution path regardless of the flag or platform compatibility/] },
      { resource: "references/autopilot.md", section: "## Select one related task", requires: [/node -p "process.platform"/, /Map `win32` to `windows`, `darwin` to `macos`, and `linux` to `linux`/, /A Linux runtime in WSL is `linux`/, /Unsupported or unknown runtime platforms leave selection waiting/, /Do not substitute a configured platform, remote host OS, or requested task platform for the observed runtime/, /daynight task ready --allow-agents true --compatible-platform <actual-platform> --json/, /daynight task list --allow-agents true --compatible-platform <actual-platform> --json/, /Both ready and supplemental list queries retain the actual-platform filter before pagination/, /Pass the selected ID, automatic-selection mode and actual platform to `run-task`/, /Immediately before setting in_progress, reread the full task with `daynight task show <task-id> --json` and recheck `todo`, ready, `allowAgents=true`, and `requiredPlatform` either null or equal to the same actual platform/, /A changed or incompatible requirement prevents starting and requires a new selection decision/, /using the exact version from this full-task recheck with `--if-version`/, /An automatically selected ID passed to run-task remains automatic selection and does not acquire this manual exception/] },
      { resource: "references/run-task.md", section: "## Establish the task and stage", requires: [/An explicitly user-selected task may use the manual execution path regardless of `allowAgents` or platform compatibility/, /An automatically selected ID passed here remains automatic selection, even though run-task receives a concrete ID/, /Carry its actual runtime platform from autopilot/, /Immediately before setting in_progress, reread the full task and recheck `todo`, ready, `allowAgents=true`, and `requiredPlatform` either null or equal to that same actual platform/, /A changed or incompatible requirement prevents starting and requires a new selection decision/, /Use the exact version from this full-task recheck with `--if-version`/] },
      { resource: "references/goal.md", section: "## Advance and accept the whole Goal", requires: [/actual-runtime platform compatibility/, /platform-filtered queries/, /preserve automatic-selection context for run-task's full-task recheck before setting in_progress/] },
    ],
  },
  {
    id: "registration-without-execution",
    input: "Creation is authorized and all task artifacts are readable; execution was not requested.",
    obligation: "Register todo work, verify owned resources, and return without execution.",
    propositions: [
      { resource: "references/create-task.md", section: "## Register and verify", requires: [/Create new tasks in `todo`/, /Read back each complete task, its attachment inventory and required contents/, /Registration leaves work todo and does not execute it/, /Return after verified registration without selecting or executing a task/] },
      { resource: "SKILL.md", section: "## Shared constraints", requires: [/Create tasks only with explicit permission for their scope/, /Creation produces `todo` for every normal task and Goal stage/] },
    ],
  },
  {
    id: "fixed-authorized-queue",
    input: "The user explicitly authorized a fixed Goal queue with allowAgents=false.",
    obligation: "Use its manual path and existing authorization for ready successors without enabling discovery permission.",
    propositions: [
      { resource: "references/autopilot.md", section: "## Select one related task", requires: [/fixed Goal queue/, /manual execution path regardless of `allowAgents`/, /Existing scoped authorization covers its ready successors without per-task reauthorization/, /Automatic selection never enables `allowAgents`/] },
      { resource: "SKILL.md", section: "## Shared constraints", requires: [/Existing explicit authorization may cover a stated task or fixed Goal queue and its ready successors without another per-task authorization/] },
    ],
  },
  {
    id: "authorized-ready-start",
    input: "An authorized ready todo has complete prerequisites and stage inputs, with execution authorized.",
    obligation: "Start using its decision version and confirm in_progress before work begins.",
    propositions: [
      { resource: "references/run-task.md", section: "## Establish the task and stage", requires: [/For ready `todo`, begin only when dependencies are done, required stage inputs are complete and the work is authorized/, /Both kinds must be done before entering in_progress or done/, /Use `task set-status <task-id> in_progress` with the exact version observed for that decision and confirm in_progress before starting/] },
      { resource: "references/autopilot.md", section: "## Select one related task", requires: [/Readiness checks all prerequisites, not stage artifact completeness or execution authorization/, /External prerequisites still block readiness/, /cross-chain classification does not authorize executing them or expand the confirmed scope/, /enters in_progress using the version observed for that decision before starting/] },
    ],
  },
  {
    id: "resume-existing-work",
    input: "A checkpoint identifies an existing in_progress task after interruption.",
    obligation: "Recover its actual work and identity; in_progress is not a claim lock or arbitrary selection.",
    propositions: [
      { resource: "references/run-task.md", section: "## Establish the task and stage", requires: [/For `in_progress`, recover existing work and coordinate/, /the state is not an assignee lock or lease/, /Preserve the requested task ID through recovery and waiting/] },
      { resource: "references/autopilot.md", section: "## Restore the current target", requires: [/Resume this session's current task before selecting new work/, /An arbitrary `in_progress` task is not this session's target/] },
    ],
  },
  {
    id: "conflict-needs-new-decision",
    input: "A write using a previously reviewed version returns a conflict.",
    obligation: "Reread and reconsider rather than changing the version and replaying automatically.",
    propositions: [
      { resource: "references/handbook.md", section: "**Task concurrency.**", requires: [/the exact version read for that decision using `--if-version`/, /Preserve full int64 decimal digits without numeric rounding/, /On a conflict, reread and reconsider/, /not merely a newer version/, /Never retry a mutation automatically/] },
      { resource: "references/run-task.md", section: "## Establish the task and stage", requires: [/A stale version or changed prerequisite requires rereading and reconsidering, with no automatic mutation retry/] },
    ],
  },
  {
    id: "unknown-write-outcome",
    input: "A mutation response is lost or cancelled after dispatch.",
    obligation: "Preserve the failure and resource identity, then reconcile real state before another mutation.",
    propositions: [
      { resource: "references/handbook.md", section: "**Unconfirmed writes.**", requires: [/A timeout, cancellation or lost response may follow an applied change/, /Read back current task fields or attachment contents before another mutation/, /cancellation does not prove rollback/, /For an unconfirmed create, establish identity from complete fields and operation context/, /matching title or an empty lookup alone is insufficient/, /Preserve actual errors and resource IDs/, /rather than reporting success or blindly resending a write/] },
      { resource: "references/handbook.md", section: "**Attachment independence.**", requires: [/Attachment changes do not change the task's version, status, or update timestamp/, /Task versions therefore cannot protect attachment writes/] },
      { resource: "SKILL.md", section: "## Shared constraints", requires: [/reconcile uncertain results before further mutations, and preserve actual failures/] },
    ],
  },
  {
    id: "open-pr-retains-task",
    input: "A delivery task passes acceptance but a required PR is open, or the user requests keeping that PR for review.",
    obligation: "Keep in_progress and the checkpoint; neither auto-merge nor complete to unlock successors.",
    propositions: [
      { resource: "references/run-task.md", section: "## Confirm completion or return waiting", requires: [/passing CI, approved review, and an open PR do not satisfy this condition/, /If the user requests an open PR for review or forbids merging/, /preserve `in_progress` and the waiting checkpoint/, /Do not enable auto-merge/, /Do not declare completion or select other work to bypass a wait/] },
      { resource: "references/autopilot.md", section: "## Advance serially and accept the scope", requires: [/An explicit no-merge or user-review requirement on a delivery task is such a wait/, /never permits auto-merge or marking the task done/, /Return without replacing the target/] },
    ],
  },
  {
    id: "accepted-completion",
    input: "All stage acceptance and required authorized PR merges are confirmed, or there is no PR delivery path.",
    obligation: "Record readable evidence, reread in_progress and complete its observed version; stage completion is bounded.",
    propositions: [
      { resource: "references/run-task.md", section: "## Confirm completion or return waiting", requires: [/every necessary delivery PR is merged/, /Completion rules grant no merge, deployment, external communication, or mainline push permission/, /For tasks without a development or PR delivery path, use their stated stage acceptance/, /confirm required evidence is recorded and readable/, /reread the complete in-progress task and use `task set-status <task-id> done` with its exact observed version/, /Only service confirmation establishes the status update/, /Neither establishes whole-Goal completion/] },
      { resource: "references/goal.md", section: "## Execute the appropriate stage", requires: [/Completion satisfies dependencies and grants no delivery execution permission/] },
    ],
  },
  {
    id: "goal-registration-only",
    input: "The user asks only to register a Goal, without starting a discussion.",
    obligation: "Create only the current requirements task as todo and return; do not precreate architecture or delivery work.",
    propositions: [
      { resource: "references/goal.md", section: "## Identify the current discussion", requires: [/A registration-only request creates only the current discussion task in `todo` and returns without execution/] },
      { resource: "references/goal.md", section: "## Start requirements discussion", requires: [/Create or reuse only the requirements discussion task/, /Do not create an architecture placeholder or delivery tasks at this point/] },
      { resource: "references/create-task.md", section: "## Choose the tracked outcome", requires: [/A registration-only request leaves the current stage todo and returns/] },
    ],
  },
  {
    id: "goal-discussion-start",
    input: "The user explicitly asks to begin discussing a Goal's requirements.",
    obligation: "Register only requirements and use the versioned status setter to enter in_progress for discussion.",
    propositions: [
      { resource: "references/goal.md", section: "## Identify the current discussion", requires: [/A request to start a Goal discussion authorizes creating and starting that discussion task so it becomes `in_progress`/] },
      { resource: "references/goal.md", section: "## Start requirements discussion", requires: [/Each task starts in `todo`/, /use `task set-status <task-id> in_progress` with the version observed for that decision and confirm `in_progress`/, /All direct prerequisites must be done/] },
      { resource: "references/run-task.md", section: "## Establish the task and stage", requires: [/authorizes entering in_progress for that discussion under the Goal protocol; registration alone does not/] },
    ],
  },
  {
    id: "goal-requirements-confirmation",
    input: "Requirements text is complete; the user has not confirmed it or asked to proceed.",
    obligation: "Keep requirements in_progress; user confirmation and direction must precede completion and creating solution discussion.",
    propositions: [
      { resource: "references/goal.md", section: "## Confirm requirements and start solution discussion", requires: [/Keep the requirements task `in_progress` until the user explicitly confirms the current requirements and directs the next discussion/, /Agent confidence, completed text, a review result, or elapsed time does not satisfy this gate/, /A material revision after confirmation requires renewed user confirmation before advancement/, /Do not create the solution discussion until that completion is confirmed/, /ordinary prerequisite on the completed requirements task/] },
    ],
  },
  {
    id: "goal-unconfirmed-solution",
    input: "Architecture and a draft breakdown exist, but the user has not confirmed the solution.",
    obligation: "Keep the draft in the solution discussion task and wait; do not register delivery tasks or substitute CI/review for user confirmation.",
    propositions: [
      { resource: "references/goal.md", section: "## Execute the appropriate stage", requires: [/The solution task owns the current architecture, proposal, and draft breakdown/, /Do not register delivery subtasks before the user confirms the current solution/, /A discussion task completes from user-confirmed Daynight material and its stated stage acceptance/, /a generic repository PR rule does not add a merge prerequisite to a Daynight discussion/, /Successful CI or a design review cannot replace the user's confirmation/] },
    ],
  },
  {
    id: "goal-confirmed-breakdown",
    input: "The user confirms the current solution and its actual delivery breakdown.",
    obligation: "Register real outcome tasks with verified dependencies and materials, then complete the discussion; delivery remains todo unless execution is already authorized.",
    propositions: [
      { resource: "references/goal.md", section: "## Register the confirmed delivery breakdown", requires: [/Only after user solution confirmation, create or reuse the concrete delivery tasks/, /Create new delivery tasks in `todo`/, /Solution confirmation authorizes the confirmed breakdown's registration, not implementation, autopilot/, /Every delivery root without another ordinary implementation prerequisite depends directly on the solution discussion/, /Read back every task, required attachment, shared input, and dependency/, /Keep the solution discussion `in_progress` when registration is incomplete/] },
      { resource: "references/goal.md", section: "## Execute the appropriate stage", requires: [/Complete the solution discussion only after the accepted solution and actual registered delivery tasks, their required materials, and their dependencies are read back and verified/, /Completion satisfies dependencies and grants no delivery execution permission/] },
    ],
  },
  {
    id: "goal-indirect-architecture-inputs",
    input: "A new agent receives delivery task B in architecture -> A -> B, with no discussion history; A is complete and the architecture documents belong to the solution task.",
    obligation: "B's description directly identifies the architecture task and every required document; registration verifies those inputs and execution reads them before implementation, without duplicating documents or adding dependency edges.",
    propositions: [
      { resource: "references/goal.md", section: "## Register the confirmed delivery breakdown", requires: [/Every delivery task's description must directly list the architecture task ID and all required architecture source locations/, /full paths under the source task for each actual required attachment document/, /verified immutable repository references for repository documents/, /This applies to indirect successors as well as delivery roots/, /a reference only in another task or inside an attachment is insufficient/, /These input references do not add execution dependencies or duplicate shared documents/, /Check each delivery task's description, including indirect successors/, /confirm that each reference resolves to the intended readable content/] },
      { resource: "references/create-task.md", section: "## Write task-specific content", requires: [/For every Goal delivery task, list the architecture task ID and all required architecture source locations directly in its description, including indirect successors/] },
      { resource: "references/create-task.md", section: "## Register and verify", requires: [/check every task's description, including indirect successors, for its architecture task ID and required document references/, /read the referenced contents under the Goal protocol/] },
      { resource: "references/run-task.md", section: "## Establish the task and stage", requires: [/Before implementation, read every required architecture source listed in the delivery task's description/, /architecture task is only an indirect prerequisite/, /Missing required content, an unreadable required source, or a missing required architecture reference or input leaves execution unready/] },
    ],
  },
  {
    id: "goal-shared-inline-architecture",
    input: "The architecture task owns the complete design in its description with no architecture attachments; indirect successor B must consume that design after implementation task A completes.",
    obligation: "B directly identifies the owning architecture task and applicable description sections, reads them through task show, and does not invent paths or relocate/copy the design to manufacture an attachment source.",
    propositions: [
      { resource: "references/task-content.md", section: "## Resolve and read sources", requires: [/owning task ID and content location: its description and applicable sections for inline content/, /Read source task descriptions with `task show --json`/, /Do not invent an attachment path for inline content, relocate or copy it merely to satisfy a reference format/, /Every Goal delivery task's description must directly list the architecture task ID and all required architecture source locations, including indirect successors/, /For inline architecture, name the source task's description and applicable sections/, /For each actual required attachment document, include its full path/] },
      { resource: "references/goal.md", section: "## Register the confirmed delivery breakdown", requires: [/architecture source locations: description and applicable sections for inline design/, /Do not fabricate an attachment path or copy or relocate inline architecture to fit this index/, /This applies to indirect successors as well as delivery roots/, /These input references do not add execution dependencies or duplicate shared documents/] },
      { resource: "references/create-task.md", section: "## Write task-specific content", requires: [/Reference the owning task ID and its description with applicable sections for inline content/, /Read source descriptions through `task show --json`/, /all required architecture source locations directly in its description, including indirect successors/] },
      { resource: "references/run-task.md", section: "## Establish the task and stage", requires: [/Resolve real shared input references using the owning task ID and description\/sections/, /Read source descriptions through `task show --json`/, /Before implementation, read every required architecture source listed in the delivery task's description: the owning architecture task's inline description and applicable sections/, /architecture task is only an indirect prerequisite/] },
    ],
  },
  {
    id: "markdown-resource-ownership",
    input: "A Markdown brief links its own plan and references a prototype owned by another task.",
    obligation: "Keep a self-contained brief and one detailed owner; resolve real resources from the proper task or document base.",
    propositions: [
      { resource: "references/create-task.md", section: "## Write task-specific content", requires: [/description that identifies its concrete work, responsibility, and actual content sources/, /Complete inline content needs no primary attachment/, /reference-owned and mixed content are also valid without repeating complete documents/, /Reference the owning task ID and its description with applicable sections for inline content, full paths for actual attachments, or verified immutable repository sources/, /Read source descriptions through `task show --json` and attachment bytes through the attachment commands/, /Do not copy the whole shared packet into every task/] },
      { resource: "references/task-content.md", section: "## Content ownership and evidence", requires: [/Each detailed explanation has one owner/, /Record this task's user confirmations, acceptance conclusions, and delivery evidence in an explicitly identified location in its own description or attachments/, /do not leave them only in chat or mix them into shared design/] },
      { resource: "references/create-task.md", section: "## Author Markdown", requires: [/A relative link or image in a description starts at this task's attachment root/, /A link inside a Markdown attachment starts at that file's directory/, /Confirm an upload and read back its contents before adding its link/, /Use these paths only when those files actually belong to that task/, /A Goal stage that produces a prototype links it only after producing and confirming it/] },
      { resource: "references/handbook.md", section: "**Markdown descriptions.**", requires: [/reads preserve the original string, including line breaks and fenced code/, /Shared inputs retain their owning task ID and content location: description with applicable sections for inline content, full path for an actual attachment, or verified immutable repository URL/, /They are not cross-task relative links/] },
    ],
  },
  {
    id: "task-content-organization",
    input: "A task provides all required information inline, through readable documents, or using both, without a dedicated primary attachment.",
    obligation: "Apply the same six content requirements to every organization and identify task-owned confirmations and evidence.",
    propositions: [
      { resource: "references/task-content.md", section: "## Six content requirements", requires: [/content requirements, not six mandatory headings/, /in the description, in clearly referenced documents, or through a mixture of both/, /Complete inline content needs no primary attachment/, /Objective and requirements/, /Scope and deliverables/, /Solution and design/, /Input and output contracts/, /Acceptance criteria and verification/, /Sources/, /Judge completeness from the description and the contents actually read/, /unreadable resources, and missing decisions are insufficient/] },
      { resource: "references/create-task.md", section: "## Register and verify", requires: [/all six content requirements, the explicit task-owned evidence location/] },
      { resource: "references/run-task.md", section: "## Establish the task and stage", requires: [/Complete inline content needs no primary attachment/, /document-owned and mixed organization are valid when the combined contents satisfy the same six requirements/] },
    ],
  },
  {
    id: "task-content-source-sufficiency",
    input: "The task references shared documents, further required sources, or producer/consumer contracts; some source is unreadable or materially inconsistent.",
    obligation: "Read applicable contents recursively, keep the task boundary, and resolve missing decisions or inconsistent contracts before reporting readiness.",
    propositions: [
      { resource: "references/task-content.md", section: "## Resolve and read sources", requires: [/owning task ID and content location: its description and applicable sections for inline content, or the complete attachment path for an actual attachment/, /Read the required source contents, including further references needed for the current stage/, /Track already-read resource identities to avoid circular reading/, /A reference cycle that supplies no actual required content cannot pass/, /Limit traversal to this task's requirements/, /Resolve material conflicts between the description and sources or between sources before declaring the content sufficient/] },
      { resource: "references/task-content.md", section: "## Input and output contracts", requires: [/Describe actual exchanges rather than inventing an interface to fill a template/, /Check the relevant producer and consumer explanations for consistency/, /source reference does not create an execution dependency/] },
      { resource: "references/task-content.md", section: "## Check sufficiency", requires: [/Unknown requirements, design choices, acceptance thresholds, and interface decisions are concrete blockers, not details to invent/, /A material scope or behavior change requires user confirmation/] },
    ],
  },
  {
    id: "handoff-authorized-blocked-todo",
    input: "The user explicitly requests handoff of a false-permission todo task whose implementation prerequisite is unfinished but agreed interfaces and design are readable.",
    obligation: "Review real content and authorized changes, then allow version-bound permission enable without starting execution or removing blockers.",
    propositions: [
      { resource: "SKILL.md", section: "## Select a mode", requires: [/`handoff <task-id>`/, /references\/handoff\.md/] },
      { resource: "references/handoff.md", section: "## Review the task and its sources", requires: [/retaining its exact version, status, `allowAgents`, platform, dependencies, and worker record/, /organize its description or authorized source documents only from existing confirmed information/, /Missing decisions block review/, /Unfinished prerequisites need not prevent handoff when the design and agreed interfaces already define the future work/, /preserve their real blockers/] },
      { resource: "references/handoff.md", section: "## Enable permission and reconcile", requires: [/For a reviewed false-permission `todo`/, /`task update --allow-agents true` with the exact version on which the final review decision was based/, /Omit unrelated options and preserve dependencies, platform, PR references, worker data, and other fields/, /Do not update status to make the task eligible/] },
      { resource: "references/handoff.md", section: "## Report and return", requires: [/Return without selecting work or starting execution/] },
    ],
  },
  {
    id: "handoff-no-implicit-authorization",
    input: "A task is created, broken down, or automatically discovered without an explicit request to hand it off.",
    obligation: "Keep automatic-execution permission unchanged and preserve separate execution and delivery authorization.",
    propositions: [
      { resource: "SKILL.md", section: "## Shared constraints", requires: [/Automatic selection and execution must not enable this permission themselves/, /Only an explicitly authorized \[handoff\]\(references\/handoff\.md\) may enable it after content review/, /handoff does not start execution or replace other authority/] },
      { resource: "references/create-task.md", section: "## Register and verify", requires: [/Creation and breakdown do not enable it/, /A separate, explicitly requested \[handoff\]\(handoff\.md\) reviews each task before enabling permission/] },
      { resource: "references/goal.md", section: "## Register the confirmed delivery breakdown", requires: [/`allowAgents=false`; registration does not enable it/, /Only a separately explicit \[handoff\]\(handoff\.md\) may review and enable permission/, /does not supply delivery execution authorization or advance the discussion gate/] },
    ],
  },
  {
    id: "handoff-enabled-reaudit",
    input: "An already-enabled task fails content re-audit while it remains available to the scheduler.",
    obligation: "Perform a read-only re-audit, report failure and scheduling exposure, and preserve permission without assuming suspension.",
    propositions: [
      { resource: "references/handoff.md", section: "## Review the task and its sources", requires: [/Already-enabled tasks receive a read-only re-audit/, /they may be selected while review is underway/, /Do not assume they are paused or edit their content under that assumption/] },
      { resource: "references/handoff.md", section: "## State and ownership rules", requires: [/do not rewrite the same flag as an audit marker/, /If an already-enabled task fails re-audit, report the failed review, actual flag, and continued scheduling exposure/, /Keep its permission unchanged/, /Revocation or stopping needs separately explicit scope/, /A failed review is not a successful handoff or an implicit suspension/] },
    ],
  },
  {
    id: "handoff-state-and-worker-continuity",
    input: "Handoff encounters a running task, a completed task, or active/released worker ownership.",
    obligation: "Respect running permission locks, completed-task mode policy, and the original execution's controlled ownership and continuity.",
    propositions: [
      { resource: "references/handoff.md", section: "## State and ownership rules", requires: [/`in_progress`, permission false/, /Report the permission lock; do not newly enable or reset status to evade it/, /Review does not pause, stop, release, or transfer execution/, /Report completion and no handoff needed; do not reopen or update permission/, /This is mode policy, not an API prohibition/, /Preserve ownership and execution history/, /confirmed original worktree\/Agent continuity/, /enabling permission does not authorize a fresh execution elsewhere/] },
    ],
  },
  {
    id: "handoff-concurrency-and-unknown-outcome",
    input: "Required sources change, the permission write conflicts or loses its response, or scheduling claims the task before the final GET.",
    obligation: "Recheck actual content, reconcile uncertain writes with reads only, and report observed state without replay or unsupported attribution.",
    propositions: [
      { resource: "references/handoff.md", section: "## Enable permission and reconcile", requires: [/Finish authorized document changes and read them back before enabling permission/, /compare actual contents, not merely inventory or timestamps/, /not atomically protected by the task version/, /On a version conflict, reread and reassess/, /reconcile by reads only before considering any new mutation; do not automatically replay it/, /An unreadable reconciliation leaves the outcome unconfirmed/, /the final GET may show a higher version and `in_progress` with a worker/, /do not require equality with the update response's version or retry because execution was observed/, /Without a confirmed write result, report only the observed state rather than attributing the change to this operation/, /If final source verification fails or reveals material changes, report review incomplete or failed and the actual permission\/state/, /Do not claim success or automatically revoke the flag/] },
      { resource: "references/task-content.md", section: "## Check sufficiency", requires: [/Verify mutable contents before enabling permission and read the required contents again before execution/, /A content check is not an atomic freeze or permanent certification/] },
      { resource: "references/handoff.md", section: "## Report and return", requires: [/Distinguish a confirmed permission update from an uncertain write and a read-only re-audit/, /Permission true alone proves neither execution started nor completion/, /For a fixed set, review and report each task separately/] },
    ],
  },
];

export const verifyInstructionScenario = (bundle: InstalledSkillContract, scenario: InstructionScenario): readonly string[] => {
  const checked: string[] = [];
  for (const proposition of scenario.propositions) {
    const document = bundle.documents.get(proposition.resource);
    assert.equal(typeof document, "string", `Installed scenario ${scenario.id} requires ${proposition.resource}.`);
    const normalized = document!.replaceAll("\r\n", "\n");
    const start = normalized.indexOf(proposition.section);
    assert.ok(start >= 0, `${proposition.resource} contains ${proposition.section}.`);
    const following = normalized.slice(start + proposition.section.length);
    const end = following.search(proposition.section.startsWith("## ") ? /\n## / : /\n\n\*\*[^*]+\.\*\*/);
    const section = following.slice(0, end === -1 ? undefined : end).replaceAll(/\s+/g, " ");
    for (const requirement of proposition.requires) assert.match(section, requirement, `${scenario.id}: ${scenario.obligation} (${proposition.resource} / ${proposition.section})`);
    checked.push(`${proposition.resource} / ${proposition.section}`);
  }
  return checked;
};
