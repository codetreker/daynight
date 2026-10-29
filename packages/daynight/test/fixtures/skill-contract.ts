import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const requiredSkillResources = [
  "SKILL.md", "references/handbook.md", "references/create-task.md", "references/handoff.md",
  "references/run-task.md", "references/autopilot-managed-task.md", "references/task-execution.md",
  "references/goal.md", "references/task-content.md",
] as const;

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
  for (const resource of requiredSkillResources) assert.ok(documents.has(resource), `The installed bundle contains ${resource}.`);
  assert.equal(documents.has("references/autopilot.md"), false, "The removed automatic execution mode is not packaged.");
  assert.equal(documents.has("references/execute-task-in-managed.md"), false, "The renamed managed entrypoint is not packaged under its old name.");
  const entrypoint = documents.get("SKILL.md");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(entrypoint!);
  assert.notEqual(frontmatter, null, "The installed skill has YAML frontmatter.");
  const metadata: unknown = parseYaml(frontmatter![1]!);
  assert.ok(typeof metadata === "object" && metadata !== null && !Array.isArray(metadata));
  assert.ok("name" in metadata && metadata.name === "using-daynight");
  assert.ok("description" in metadata && typeof metadata.description === "string" && metadata.description.trim().length > 0);
  const contract = { documents, resources, metadata: { name: metadata.name, description: metadata.description } };
  verifyExecutionResourceSeparation(contract);
  return contract;
};

export const verifyExecutionResourceSeparation = (bundle: InstalledSkillContract): void => {
  const links = (resource: string): readonly string[] => {
    const content = bundle.documents.get(resource);
    assert.equal(typeof content, "string", `The installed bundle contains ${resource}.`);
    return [...prose(content!).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
      .map((match) => path.posix.basename(match[1]!.split("#")[0]!));
  };
  const ordinary = "references/run-task.md";
  const managed = "references/autopilot-managed-task.md";
  const shared = "references/task-execution.md";
  assert.ok(links(ordinary).includes("task-execution.md"), "Ordinary execution loads shared delivery guidance.");
  assert.ok(links(managed).includes("task-execution.md"), "Managed execution loads the same shared delivery guidance.");
  assert.ok(!links(ordinary).includes("autopilot-managed-task.md"), "Ordinary execution does not load the managed entrypoint.");
  assert.ok(!links(managed).includes("run-task.md"), "Managed execution does not load the ordinary lifecycle.");
  for (const entrypoint of ["run-task.md", "autopilot-managed-task.md"]) {
    assert.ok(!links(shared).includes(entrypoint), `Shared delivery guidance does not load ${entrypoint}.`);
  }
  assert.doesNotMatch(bundle.documents.get(ordinary)!, /--claim-id\b|properties\.worker|claimId/);
  assert.doesNotMatch(bundle.documents.get(shared)!, /task set-status\b|--claim-id\b/);
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
    id: "worker-managed-context",
    input: "The worker startup prompt explicitly supplies managed environment, skill, mode and an assignment, or its context is incomplete or mismatched.",
    obligation: "Route only explicit worker startup assignments to managed instructions and verify the original claim without an ordinary fallback.",
    propositions: [
      { resource: "SKILL.md", section: "## Select a mode", requires: [/worker-managed/, /using-daynight/, /autopilot-managed-task/, /startup prompt/, /ordinary/i] },
      { resource: "references/autopilot-managed-task.md", section: "## Establish the assignment", requires: [/projectId/, /taskId/, /claimId/, /worktreeId/, /branch/, /configuration selected for this invocation/, /missing|incomplete/, /mismatch/, /return waiting without task or business writes/, /Do not.*(?:infer|guess)|not.*(?:infer|guess)/] },
      { resource: "references/autopilot-managed-task.md", section: "## Verify the existing execution", requires: [/in_progress/, /active/, /with the supplied `claimId` and `worktreeId`/, /branch/, /configuration supplied for this invocation/, /current settings appropriate to the recorded agent/, /never substitute/] },
    ],
  },
  {
    id: "worker-managed-existing-execution",
    input: "An already-active controller assignment resumes with its original worktree, or a matching completed claim is encountered.",
    obligation: "Resume only its existing execution and retain controller ownership of system resources.",
    propositions: [
      { resource: "references/autopilot-managed-task.md", section: "## Verify the existing execution", requires: [/completed/, /done/, /without reexecuting|without executing|do not reexecute/, /Do not claim it, set it to `in_progress`, select candidates/, /refresh|reread/, /task writes|mutation/, /same active claim/] },
      { resource: "references/autopilot-managed-task.md", section: "## Execute within controller-owned resources", requires: [/Do not create, switch, or remove/, /worktree/, /branch/, /--delete-branch/, /worker owns resource cleanup/, /do not delete its worktree or close its workspace/] },
    ],
  },
  {
    id: "worker-managed-authorized-delivery",
    input: "A valid worker-managed assignment has a delivery PR whose current-head checks, approvals, blocking threads and mergeability satisfy the repository rules.",
    obligation: "Use the assignment's sufficient prior delivery authorization to merge immediately after verifying all gates, honoring explicit user restrictions without another permission request or an invented post-merge CI gate.",
    propositions: [
      { resource: "references/autopilot-managed-task.md", section: "## Establish the assignment", requires: [/A valid worker-managed assignment already carries sufficient authorization for its in-scope delivery, including PR merge/, /Do not request additional permission for those steps/, /Honor explicit user restrictions, pause requests, and revocation/] },
      { resource: "references/autopilot-managed-task.md", section: "## Deliver the assigned task", requires: [/required checks, current-head approvals, blocking-thread resolution, and mergeability all satisfy the repository's rules/, /merge immediately without requesting additional permission/, /successful required checks/, /handled blocking review threads/, /actual reviewer approval for the current head/, /Do not wait for post-merge mainline CI unless the user explicitly requires that verification/] },
    ],
  },
  {
    id: "worker-managed-pending-delivery",
    input: "A required PR is still open because CI or review is pending, or a bounded poll times out.",
    obligation: "Keep executing the same assignment through ordinary delivery waits; a poll timeout does not establish an external blocker or completion.",
    propositions: [
      { resource: "references/autopilot-managed-task.md", section: "## Wait for delivery results", requires: [/Pending PR CI or review is ongoing execution, not external intervention/, /A polling timeout ends only that poll; keep waiting and inspecting results/, /Do not return merely because a required PR remains unmerged while its CI or review is pending/] },
    ],
  },
  {
    id: "worker-managed-claim-completion",
    input: "The assigned claim has met acceptance and delivery gates, or its final write is refused or loses its response.",
    obligation: "Make the explicit claim-bound final mutation with the observed version and reconcile only that claim without fallback or replay.",
    propositions: [
      { resource: "references/autopilot-managed-task.md", section: "## Complete the original claim", requires: [/reread/, /active claim/, /daynight task set-status <task-id> done --project <project-id> --claim-id <claim-id> --if-version <observed-version>/, /final task mutation/, /properties\.worker\.state=completed/, /original claim/, /never falls back to ordinary completion or automatic replay/, /reconcile only the original claim/, /An unreadable result remains unconfirmed/, /observed claim change stops further business writes/] },
      { resource: "references/handbook.md", section: "**Task status.**", requires: [/task set-status <task-id> done --claim-id <claim-id> --if-version <version>/, /valid only with `done`/, /never infers it from task data or the environment/, /Omit `--claim-id` for ordinary status setting/, /refusal never causes fallback between these operations/, /checks the exact version before a same-status no-op/] },
    ],
  },
  {
    id: "worker-managed-bounded-wait",
    input: "An assigned task reaches completion or cannot progress because a demonstrated external blocker requires intervention.",
    obligation: "Return concrete intervention needs to the controller, preserving unfinished execution without selecting another task or Goal stage.",
    propositions: [
      { resource: "references/autopilot-managed-task.md", section: "## Wait for delivery results", requires: [/A demonstrated blocker/, /requires external intervention/, /minimum needed intervention/, /then return waiting to the controller/, /Preserve the assignment in `in_progress`/] },
      { resource: "references/autopilot-managed-task.md", section: "## Return to the controller", requires: [/completion|completes/, /wait|intervention/, /does not select a successor or advance a Goal stage/, /worker|controller/, /human|user/, /PR/, /acceptance/] },
      { resource: "references/task-execution.md", section: "## Confirm acceptance readiness", requires: [/every necessary delivery PR/, /is merged/, /human|user/, /in progress/] },
    ],
  },
  {
    id: "registration-without-execution",
    input: "Creation is authorized and all task artifacts are readable; execution was not requested.",
    obligation: "Register todo work, verify owned resources, report its identity and status, and ask before waiting for explicit execution authorization; refusal, silence and ambiguity do not start work.",
    propositions: [
      { resource: "references/create-task.md", section: "## Register and verify", requires: [/Create new tasks in `todo`/, /Read back each complete task, its attachment inventory and required contents/, /Registration leaves work todo and does not execute it/, /After verified registration, report the confirmed task IDs and current statuses/, /ask whether to start the identified task and wait for an explicit answer, leaving it todo/, /Do not select another task or start later delivery work from registration alone/] },
      { resource: "SKILL.md", section: "## Shared constraints", requires: [/Create tasks only with explicit permission for their scope/, /Creation produces `todo` for every normal task and Goal stage/, /If no explicit execution authorization covers that task, ask whether to start the identified task and wait for an explicit affirmative answer/, /Keep it `todo` and do not begin its implementation or other task execution while authorization is missing/, /Creation, readiness, silence, elapsed time, and an ambiguous reply do not authorize execution/, /A refusal ends the current startup proposal/, /silence leaves it waiting/, /an ambiguous reply requires clarification before starting/] },
    ],
  },
  {
    id: "authorized-ready-start",
    input: "An authorized ready todo has complete prerequisites and stage inputs, with execution authorized.",
    obligation: "Start using its decision version and confirm in_progress before work begins.",
    propositions: [
      { resource: "references/run-task.md", section: "## Start or resume the task", requires: [/ready/, /`todo`/, /dependencies/, /authorized/, /task set-status <task-id> in_progress/, /exact version/, /confirm.*in_progress/] },
      { resource: "references/task-execution.md", section: "## Verify prerequisites and scope", requires: [/direct prerequisite/, /externalDependsOn/, /Both kinds must be done/, /Classification never grants permission to execute a prerequisite/] },
      { resource: "SKILL.md", section: "## Shared constraints", requires: [/Existing explicit execution authorization remains effective within its stated task or Goal scope/, /do not request it again or extend it to other work/, /The reply authorizes only the task and scope it clearly identifies; prerequisites and required inputs still apply/] },
    ],
  },
  {
    id: "resume-existing-work",
    input: "A checkpoint identifies an existing in_progress task after interruption.",
    obligation: "Recover its actual work and identity; in_progress is not a claim lock or arbitrary selection.",
    propositions: [
      { resource: "references/run-task.md", section: "## Start or resume the task", requires: [/For `in_progress`, recover existing work and coordinate/, /the state is not an assignee lock or lease/] },
    ],
  },
  {
    id: "conflict-needs-new-decision",
    input: "A write using a previously reviewed version returns a conflict.",
    obligation: "Reread and reconsider rather than changing the version and replaying automatically.",
    propositions: [
      { resource: "references/handbook.md", section: "**Task concurrency.**", requires: [/the exact version read for that decision using `--if-version`/, /Preserve full int64 decimal digits without numeric rounding/, /On a conflict, reread and reconsider/, /not merely a newer version/, /Never retry a mutation automatically/] },
      { resource: "references/run-task.md", section: "## Start or resume the task", requires: [/A stale version or changed prerequisite requires rereading and reconsidering, with no automatic mutation retry/] },
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
      { resource: "references/task-execution.md", section: "## Confirm acceptance readiness", requires: [/passing CI, approved review, and an open PR do not satisfy this condition/, /If the user requests an open PR for review or forbids merging/, /preserve the waiting checkpoint/, /Do not enable auto-merge/] },
      { resource: "references/task-execution.md", section: "## Preserve waiting context", requires: [/Do not declare completion or select other work to bypass a wait/] },
    ],
  },
  {
    id: "accepted-completion",
    input: "All stage acceptance and required authorized PR merges are confirmed, or there is no PR delivery path.",
    obligation: "Confirm readable task results, reread in_progress and complete its observed version; stage completion is bounded.",
    propositions: [
      { resource: "references/task-execution.md", section: "## Confirm acceptance readiness", requires: [/every necessary delivery PR is merged/, /Completion rules grant no merge, deployment, external communication, or mainline push permission/, /For tasks without a development or PR delivery path, use their stated stage acceptance/, /confirm the required deliverables and acceptance conclusions are readable/] },
      { resource: "references/run-task.md", section: "## Complete or return waiting", requires: [/reread the complete in-progress task/, /task set-status <task-id> done/, /exact observed version/, /Only service confirmation establishes the status update/, /Whole-Goal acceptance follows the Goal protocol/] },
      { resource: "references/goal.md", section: "## Execute the appropriate stage", requires: [/Completion satisfies dependencies and grants no delivery execution permission/] },
    ],
  },
  {
    id: "goal-registration-only",
    input: "The user asks only to register a Goal, without starting a discussion.",
    obligation: "Create only the current requirements task as todo, report its identity and status, then ask and wait before beginning that discussion; do not precreate architecture or delivery work.",
    propositions: [
      { resource: "references/goal.md", section: "## Identify the current discussion", requires: [/A registration-only request creates only the current discussion task in `todo`/, /After verification, report its identity and status/, /Without applicable execution authorization, ask whether to start that discussion and wait/, /Goal registration alone does not supply discussion-start or delivery execution authorization/] },
      { resource: "references/goal.md", section: "## Start requirements discussion", requires: [/Create or reuse only the requirements discussion task/, /Do not create an architecture placeholder or delivery tasks at this point/] },
      { resource: "references/create-task.md", section: "## Choose the tracked outcome", requires: [/Without applicable execution authorization, a registration-only request leaves the current stage todo while awaiting the explicit answer to the creation-to-execution question/] },
    ],
  },
  {
    id: "goal-discussion-start",
    input: "The user explicitly asks to begin discussing a Goal's requirements.",
    obligation: "Register only requirements and use the versioned status setter to enter in_progress for discussion.",
    propositions: [
      { resource: "references/goal.md", section: "## Identify the current discussion", requires: [/A request to start a Goal discussion authorizes creating and starting that discussion task so it becomes `in_progress`/] },
      { resource: "references/goal.md", section: "## Start requirements discussion", requires: [/Each task starts in `todo`/, /use `task set-status <task-id> in_progress` with the version observed for that decision and confirm `in_progress`/, /All direct prerequisites must be done/] },
      { resource: "references/run-task.md", section: "## Establish the task", requires: [/authorizes entering `in_progress` for that discussion under the Goal protocol; registration alone does not/] },
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
      { resource: "references/goal.md", section: "## Register the confirmed delivery breakdown", requires: [/Only after user solution confirmation, create or reuse the concrete delivery tasks/, /Create new delivery tasks in `todo`/, /Solution confirmation authorizes the confirmed breakdown's registration, not implementation/, /Every delivery root without another ordinary implementation prerequisite depends directly on the solution discussion/, /Read back every task, required attachment, shared input, and dependency/, /Keep the solution discussion `in_progress` when registration is incomplete/] },
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
      { resource: "references/task-execution.md", section: "## Read the task and stage inputs", requires: [/Before implementation, read every required architecture source listed in the delivery task's description/, /architecture task is only an indirect prerequisite/] },
      { resource: "references/task-execution.md", section: "## Verify prerequisites and scope", requires: [/Missing required content, an unreadable required source, or a missing required architecture reference or input leaves execution unready/] },
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
      { resource: "references/task-execution.md", section: "## Read the task and stage inputs", requires: [/Resolve real shared input references using the owning task ID and description\/sections/, /Read source descriptions through `task show --json`/, /Before implementation, read every required architecture source listed in the delivery task's description: the owning architecture task's inline description and applicable sections/, /architecture task is only an indirect prerequisite/] },
    ],
  },
  {
    id: "markdown-resource-ownership",
    input: "A Markdown brief provides its own requirements and references a prototype owned by another task.",
    obligation: "Keep a self-contained brief and one detailed owner; resolve real resources from the proper task or document base.",
    propositions: [
      { resource: "references/create-task.md", section: "## Write task-specific content", requires: [/description that identifies its concrete work, responsibility, and actual content sources/, /Complete inline content needs no primary attachment/, /reference-owned and mixed content are also valid without repeating complete documents/, /Reference the owning task ID and its description with applicable sections for inline content, full paths for actual attachments, or verified immutable repository sources/, /Read source descriptions through `task show --json` and attachment bytes through the attachment commands/, /Do not copy the whole shared packet into every task/] },
      { resource: "references/task-content.md", section: "## Content ownership", requires: [/Each detailed explanation has one owner/, /Save this task's results at their actual owner and make them discoverable from its description/, /do not accumulate an execution log/] },
      { resource: "references/create-task.md", section: "## Author Markdown", requires: [/A relative link or image in a description starts at this task's attachment root/, /A link inside a Markdown attachment starts at that file's directory/, /Confirm an upload and read back its contents before adding its link/, /Use this path only when those files actually belong to that task/, /A Goal stage that produces a prototype links it only after producing and confirming it/] },
      { resource: "references/handbook.md", section: "**Markdown descriptions.**", requires: [/reads preserve the original string, including line breaks and fenced code/, /Shared inputs retain their owning task ID and content location: description with applicable sections for inline content, full path for an actual attachment, or verified immutable repository URL/, /They are not cross-task relative links/] },
    ],
  },
  {
    id: "task-session-content-boundary",
    input: "A request combines sorting behavior with registration-only authorization, chosen tools, agent assignments and recovery information.",
    obligation: "Keep the task definition and results in task material while execution and discussion methods, operational authorization and recovery remain session context.",
    propositions: [
      { resource: "references/task-content.md", section: "## Task and session boundary", requires: [/Tasks describe what must be achieved and delivered/, /Sessions hold how the task is executed or discussed/, /Keep execution and discussion plans, steps, tool choices, collaboration, operational authorization, progress, blockers, and recovery context in the session/, /Apply this boundary to descriptions, attachments, and referenced task material/, /Missing authorization or assignment cannot be reconstructed from a task's description, attachments, acceptance state, or status/] },
    ],
  },
  {
    id: "task-content-organization",
    input: "A task supplies its definition inline, through readable documents, or using both, without a dedicated primary attachment or session execution plan.",
    obligation: "Read the same substantive task definition in every organization, without requiring universal solutions, procedures, confirmation records or prefilled results.",
    propositions: [
      { resource: "references/task-content.md", section: "## Task definition and results", requires: [/in the description, clearly referenced documents, or a mixture of both/, /These are not mandatory headings/, /Complete inline content needs no primary attachment/, /Objective and requirements/, /Scope and constraints/, /Inputs and sources/, /Deliverables and contracts/, /Acceptance criteria/, /A task does not universally require a separate solution, implementation plan, verification procedure, confirmation record, or evidence location/, /Do not require unfinished results or prefilled result sections at registration/, /Judge completeness from the description and the contents actually read/, /unreadable resources, and missing required decisions are insufficient/, /Absence of a session execution plan is not a task-content gap/] },
      { resource: "references/create-task.md", section: "## Register and verify", requires: [/task definition/, /produced results/] },
      { resource: "references/task-execution.md", section: "## Read the task and stage inputs", requires: [/Complete inline content needs no primary attachment/, /required design inputs/, /task definition/] },
    ],
  },
  {
    id: "task-content-required-inputs-and-results",
    input: "A delivery task consumes an upstream architecture, a design task produces a proposal, and a requested runbook contains commands and steps.",
    obligation: "Retain genuine required inputs and deliverables by purpose, including current design artifacts and acceptance results; exclude the session's plan and history for producing them.",
    propositions: [
      { resource: "references/task-content.md", section: "## Task and session boundary", requires: [/A design supplied as a required input or produced as the task's deliverable is task content/, /the session's plan for producing that deliverable is session context/, /Classify information by its purpose, not its filename/, /A requested migration design, test strategy, or runbook can be a task deliverable/, /Do not invent such a deliverable to upload a session checkpoint or execution log/] },
      { resource: "references/task-content.md", section: "## Task definition and results", requires: [/Save results as they are produced: current reviewable requirements or designs, actual deliverables, acceptance conclusions, defects, and material limitations/, /An immutable revision or verified resource location may identify a result/, /commands, debugging history, CI logs, and review handling remain execution context/] },
      { resource: "references/task-content.md", section: "## Check sufficiency", requires: [/Check both directions: session context stays out, and actual requirements, required design inputs, and task results remain complete/, /does not authorize bulk edits of historical tasks or automatic changes to fields, permissions, or recorded history/] },
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
      { resource: "SKILL.md", section: "## Shared constraints", requires: [/Task creation and execution do not enable `allowAgents`/, /Only an explicitly authorized \[handoff\]\(references\/handoff\.md\) may enable it after content review/, /handoff does not start execution or replace other authority/] },
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
    id: "handoff-state-and-worker-ownership",
    input: "Handoff encounters a running task, a completed task, or active/released worker ownership.",
    obligation: "Respect running permission locks, completed-task mode policy, active resource ownership and separately authorized fresh execution after release.",
    propositions: [
      { resource: "references/handoff.md", section: "## State and ownership rules", requires: [/`in_progress`, permission false/, /Report the permission lock; do not newly enable or reset status to evade it/, /Review does not pause, stop, release, or withdraw execution/, /Report completion and no handoff needed; do not reopen or update permission/, /This is mode policy, not an API prohibition/, /Preserve ownership and execution history/, /An active execution keeps its original resources/, /A released task starts a fresh claim\/worktree\/native session only through an authorized management decision/, /enabling permission neither resumes it nor restores deleted source resources/] },
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

// Presence checks qualify the shipped artifact; contradictory additions and model behavior need independent semantic validation.
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
