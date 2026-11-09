# Hand Off One UI Improvement per Task

Use this procedure after [the audit](ui-audit.md) has established a worthwhile
improvement and the user has authorized its production task registration.
Preparation or localhost testing alone supplies no production-write permission.
Load `using-daynight` and its create, content, write-safety and handoff references;
this guide adds the audit's evidence packaging and environment separation.

## Establish a separate production command context

Resolve the actual stable CLI executable, explicit production configuration root,
current authenticated local user UUID and owning project on the intended
production origin. Keep these distinct from `DN_DEV_CLI`, `DN_DEV_ROOT` and local
fixture IDs. Run outside the playground's directory router and pass the verified
absolute CLI path, configuration root and project explicitly on each call.
Read only needed configuration fields; do not print credentials.

For example, after independently verifying these production variables:

```bash
DN_CONFIG_DIR="$DN_PROD_ROOT" "$DN_PROD_CLI" project show \
  "$DN_PROD_PROJECT_ID" --json
```

Recheck the effective origin before the write phase. A command named `daynight`
or a project display name does not establish its destination. Do not repoint the
development root or disable its router to perform production handoff. Local IDs
and fixture markers describe evidence; they are never production mutation targets.

## Choose an independent owner

Search relevant tasks, including completed ones, and active delivery work before
creating anything. Read full descriptions, required attachments, acceptance
criteria and delivery revisions. Similar titles do not establish duplication;
a completed task can concern a different state or an already superseded build.
If the same defect has an owner, reuse that owner only within the authorized
scope and respect any active execution. Do not reopen or rewrite a completed
task merely because another screenshot looks similar.

Keep exactly one independently actionable improvement per task. Different
viewport reproductions of one behavior can share that task. An unreadable header
and a keyboard action that unexpectedly changes settings remain separate tasks,
even if they affect the same page or eventually touch the same component. Do not
create an umbrella "UI optimization" delivery task. Add dependencies only when
one result is a genuine prerequisite for another; shared CSS is not a dependency.

## Prepare one complete finding package

Use [the finding package format](ui-finding-package.md) in an ignored `.tmp/`
directory for each improvement. Keep its description, prototype and evidence
independently readable. Do not require another task's draft or the chat transcript
to understand its outcome.

Write task requirements, design rationale and acceptance material in Chinese.
Keep commands, identifiers and paths unchanged. Adapt the
[Chinese task template](ui-finding-package.md#task-description-template) to this
finding's measured facts. Include the behavior that must survive the change:
permissions, original Session identity and native action semantics, unsent drafts,
background state and return navigation where relevant. An unrelated checklist or
arbitrary numeric design threshold does not improve a task's completeness.

Frontend delivery requires the interactive prototype specified by
`using-daynight`: frontend-only, representative final styling and actual
controls, including applicable long-content, narrow, empty, loading, error and
disabled states. Prefer a self-contained HTML file. Keep mock data and state in
that page's memory; no local/session storage, cookies, IndexedDB or indirect
persistence by dependencies. Reopening restores the initial state. View and
interact with it at representative sizes and locales; a screenshot or simplified
wireframe is insufficient. Keep local mockups out of source, product directories,
commits and PRs; deliver them as the owning task's attachments.

Run the local package check before uploading:

```bash
node scripts/validate-ui-finding.mjs /absolute/path/to/finding/finding.json
```

Run from the skill directory or resolve the script's absolute path. The checker
examines local files, references and hashes. It neither judges user impact nor
proves browser interaction, validates authorization or writes production tasks.
Follow its [format reference](ui-finding-package.md) for required fields and
limits; keep the human evidence and scope decisions explicit.

## Create, upload and read back before enabling

Apply the following sequence to each task separately:

1. Finish the independently reviewable material and duplicate check. Give the
   create description a unique nonsensitive finding marker retained in the local
   package. This marker distinguishes an uncertain creation; it is not proof by
   itself. Keep the create payload available until reconciliation is complete.
2. Create the task in the verified production project with automatic execution
   disabled. Preserve the returned ID immediately and read the full task back.
   Initial inline content must identify the problem and scope; do not publish
   references to attachments that are not yet present.
3. Upload each required attachment to its intended case-sensitive relative path.
   Read every file back successfully and compare its bytes or SHA-256 against the
   local package, including prototype resources. A listed path or successful
   upload response alone does not establish the required content. A failed read
   can leave partial output, so require a successful exit before comparing.
4. Read the full task, preserve its exact decimal version, then save the complete
   description with verified relative resource references using `--if-version`.
   Read it back. Attachment writes do not increment task version; reread mutable
   required sources rather than trusting unchanged metadata.
5. Apply the `using-daynight` content and authenticated-responsibility review to
   this specific task. Confirm its non-null `assignedTo` equals the independently
   known current local user UUID; inspect platform/Worker requirements and real
   prerequisites without changing them as part of handoff. Resolve material
   ambiguity before enabling.
6. If automatic execution is authorized, enable only after a fresh review against
   the current exact task version and current required attachment content. On a
   version or assignment conflict, reread and reassess rather than substituting
   a new version into the old decision. Read back the full resulting task and
   required inputs; report actual permission, status and any Worker claim.

Keep multiline content as data: pass one structured argument or safely loaded
file content, never shell-evaluate the description. Consult current CLI help for
upload and update switches. Do not combine external mutations in a bulk retrying
script; each task and attachment can succeed independently.

If only registration was requested, stop after readback with permission disabled.
If a task is already active or enabled, follow `using-daynight`'s state-specific
read-only handoff rules; do not reset it to replay this sequence. Handoff does not
authorize executing the task in this session, altering assignment or starting
another Worker.

## Reconcile partial and unknown writes

When create times out without an ID, query the same production origin and owning
project using current CLI inventory/search, including completed work if necessary.
Locate the unique marker, then read candidate tasks fully and compare description,
assignment, creation context and scope with the retained payload. Account for
pagination and filters. A title match, marker alone or one empty page cannot prove
success or absence. If candidates are ambiguous or the inventory cannot be read,
report the unknown result and keep the payload; do not blindly create again.

Once an ID is confirmed, continue missing uploads or content updates on that same
task. If an upload response is lost, read the exact relative path and compare
bytes before deciding to upload again; the same path replaces existing content.
If permission enablement is uncertain, inspect the same task and original claim
observations. A Worker may already have advanced it to `in_progress`, so a newer
version is not a reason to retry or revoke permission.

Do not claim that a recovered observation proves which operation caused it.
Record the confirmed state, unknown response and remaining gap. Preserve the
original resources instead of manufacturing a clean retry through replacement
tasks, claims or Sessions.

## Report delivered work precisely

Return one task link per improvement, its reviewable attachment references and
actual handoff result. Distinguish created, content verified, permission enabled,
claimed and completed. `allowAgents=true` means scheduling is permitted; it is
neither a claim nor a delivered fix. Do not claim continued monitoring after
returning unless it is actually running within the authorized workflow.

Keep screenshots, reproduction inputs and acceptance evidence with their owning
task. Keep resource setup, coordination and transient execution logs in the
session or local record. Feed reusable discoveries and excluded false positives
back into [the audit method](ui-audit.md#improve-the-method-after-each-audit).
