# Hand Off Findings

Register and hand off each confirmed finding as its own Daynight task. Follow
[task creation](../../development-workflow/references/create-task.md) for task
content, platform selection and registration, and [handoff](../../development-workflow/references/handoff.md)
for content and responsibility review. Use the development workflow Goal protocol
for requirement candidates and the `using-daynight` manual (`daynight --skill`)
for product operations and write safety. This reference adds investigation needs:
a separate production context, duplicate checks across a busy project, package
attachments, review against the local package and reconciliation of uncertain
writes.

Preparation, local tests or authorization to register findings do not authorize
automatic execution.

## Establish a separate production command context

Resolve the actual stable CLI executable, explicit production configuration root,
current authenticated user UUID and owning project on the intended production
origin. Keep these distinct from `DN_DEV_CLI`, `DN_DEV_ROOT` and local fixture
IDs. Run outside the playground's directory router and pass the verified absolute
CLI path, configuration root and project explicitly on each call. Read only the
needed configuration fields; do not print credentials.

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
criteria and delivery revisions. Similar titles do not establish duplication; a
completed task can concern a different state or an already superseded build. If
the same defect has an owner, reuse that owner only within the authorized scope
and respect any active execution. Do not reopen or rewrite a completed task
merely because another observation looks similar. A change delivered during the
investigation that already resolves the finding makes the finding a duplicate.

Active design or delivery chains can own the files a finding touches, for example
a chain that is reshaping the same component. Read their descriptions. State the
interaction in the new task when their results affect each other; add a
dependency only when one result is a genuine prerequisite for the other.

Keep exactly one independently actionable improvement per task. Different
reproductions of one behavior, such as several viewports or Providers, can share
that task. An unreadable header and a keyboard action that unexpectedly changes
settings remain separate tasks, even on the same page or in the same component
file. Do not create an umbrella "optimization" task. Shared CSS is not a
dependency. A prerequisite from another task chain, such as a delivery task of an
unrelated Goal, is external: classify it with the CLI's external dependency
option under the [dependency strategy](../../development-workflow/references/dependencies.md), then read back the dependency
graph.

## Register one package

Prepare the package under [the finding package format](finding-package.md),
including its private-data screening and validation, and complete the
[freshness check](evidence.md#recheck-freshness-before-dispatch). Then apply this
sequence to each task separately:

1. Give the create description a unique nonsensitive finding marker retained in
   the local package. The marker distinguishes an uncertain creation; it is not
   proof by itself. Keep the create payload available until reconciliation is
   complete.
2. Create the task in the verified production project with automatic execution
   disabled. For a confirmed finding authorized for automatic handoff, pass
   `--status todo`; registration-only requests retain the selected status,
   `proposed` by default. Preserve the returned ID immediately and read the full task back.
   Initial inline content must identify the problem and scope without references
   to attachments that are not yet present. The final description with local
   images removed and local links reduced to their labels meets this requirement.
3. Upload each attachment to its intended case-sensitive relative path. Read every
   file back successfully and compare its bytes or SHA-256 with the local
   inventory, including prototype resources. A listed path or a successful upload
   response alone does not establish the required content. A failed read can
   leave partial output, so require a successful exit before comparing.
4. Read the full task, preserve its exact decimal version, then save the complete
   description with its verified relative resource references using
   `--if-version`. Read it back. Attachment writes do not increment the task
   version; reread mutable required sources rather than trusting unchanged
   metadata.
5. Review the task against the package with the read-only script below, then
   apply the `development-workflow` content and authenticated-responsibility review to
   this specific task. Confirm its non-null `assignedTo` equals the independently
   known current user UUID; inspect platform and Worker requirements and real
   prerequisites without changing them as part of handoff. Resolve material
   ambiguity before enabling.
6. If automatic execution is authorized, enable it only after a fresh review
   against the current exact task version and attachment content. On a version or
   assignment conflict, reread and reassess rather than substituting a new
   version into the old decision. Read back the full resulting task and report
   the actual permission, status and any Worker claim.

Keep multiline content as data: pass one structured argument or safely loaded
file content, and never shell-evaluate a description. Consult current CLI help for
upload and update switches. A local script may sequence one finding's create,
uploads and description update when it stops at the first failure, never retries
a write and logs each confirmed ID and stage. Run findings one at a time so each
task and attachment can succeed independently; never loop retries or continue
past an unknown outcome.

If only registration was requested, stop after readback with automatic execution
disabled. If a task is already active or enabled, follow the [state-specific read-only handoff rules](../../development-workflow/references/handoff.md); do not reset it to replay this sequence.
Handoff does not authorize executing the task in this session, altering its
assignment or starting another Worker.

## Review the registered task against its package

```bash
node .agents/skills/discover-daynight-improvements/scripts/review-finding-task.mjs \
  --cli "$DN_PROD_CLI" --config-dir "$DN_PROD_ROOT" \
  --project "$DN_PROD_PROJECT_ID" --task "$DN_TASK_ID" \
  --expect-assignee "$DN_PROD_USER_ID" one-finding/finding.json
```

The script validates the local package, then runs only `task show`,
`task attachment list` and `task attachment read`. It reports whether the title
and description equal the package, whether every local link in the description
resolves to an attachment, the byte comparison for each package file, attachments
present only remotely, and the task's version, status, permission, assignee,
platform and dependencies. It exits nonzero when anything differs. It does not
judge whether the content is sufficient, whether the responsibility is correct
or whether automatic execution may be enabled.

## Reconcile partial and unknown writes

When creation times out without an ID, query the same production origin and
owning project with the current CLI inventory or search, including completed work
if necessary. Locate the unique marker, then read candidate tasks fully and
compare description, assignment, creation context and scope with the retained
payload. Account for pagination and filters. A title match, the marker alone or
one empty page cannot prove success or absence. If candidates are ambiguous or the
inventory cannot be read, report the unknown result and keep the payload; do not
blindly create again.

Once an ID is confirmed, continue missing uploads or content updates on that same
task. If an upload response is lost, read the exact relative path and compare
bytes before deciding to upload again; the same path replaces existing content.
If permission enablement is uncertain, inspect the same task and its claim
observations. A Worker may already have advanced it to `in_progress`, so a newer
version is not a reason to retry or revoke permission.

Do not claim that a recovered observation proves which operation caused it.
Record the confirmed state, the unknown response and the remaining gap. Preserve
the original resources instead of manufacturing a clean retry through replacement
tasks, claims or Sessions.

## Report delivered work precisely

Return one task link per improvement, its reviewable attachment references and
the actual handoff result. Distinguish created, content verified, permission
enabled, claimed and completed. Do not claim continued monitoring after returning
unless it is actually running within the authorized workflow.

Keep screenshots, reproduction inputs and acceptance evidence with their owning
task. Keep resource setup, coordination and transient execution logs in the
session or local record. Feed reusable discoveries and excluded false positives
back into [the method](method.md#improve-the-method-after-each-run) and the topic
skill.
