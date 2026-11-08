# Project management

A Project is associated with a Git repository.
Project identity determines the scope of task operations; confirm the service, access identity, and project before operating on tasks.

## Discovery and selection

Within a Git repository and its worktrees, task commands may omit `--project`; the CLI matches the `origin` URL to projects on the configured service.
An explicit project overrides automatic discovery for that invocation.

Use `project list` to find accessible projects and `project show` to verify the selected project.
If there is no match or the match is ambiguous, confirm the repository, service, and target project.
Do not guess IDs or create projects merely to make a query succeed.
See the relevant `--help` for details.

## Team context

Use `team list` to read joined Teams, `team show` to inspect one, and `team
projects` to list its projects. `--team <uuid|personal>` selects an explicit
target. Without it, the CLI reads the default for the current normalized service
origin and account, or uses the account's Personal Team when no entry exists.
`team default show` validates and displays the resolved target. Invalid or
inaccessible defaults fail explicitly; listing Teams and using an explicit target
do not depend on the old default. These commands only read.

With authorization, `team default set <uuid|personal>` validates the target and
membership, then saves the default for the current service and account. It can
replace an invalid or inaccessible old default; `personal` saves the real
Personal Team ID. The command requires interactive confirmation or `--confirm`.
Cancellation, an identity mismatch, or a concurrent credential or current-default
change prevents the write. A token rotation preserves the account's default.
Team defaults do not change project discovery or explicit project and task identity.

With authorization, `team create` creates an ordinary Team, `team rename` changes
its name, and `team delete` removes an empty ordinary Team. Rename and delete use
the explicit or default Team. Their confirmation, version and uncertain-result
rules are in [write safety](write-safety.md#team-writes); use the commands' help
for exact syntax.

Use `team member list` to inspect the selected Team's member directory. With
authorization, `team member set-role` changes an existing member's role,
`team member remove` removes a member, and `team leave` removes the current
user. An ordinary Team must retain an admin; Personal membership is immutable.
These operations do not change Project grants or the configured default. Their
membership version, confirmation and receipt rules are in
[write safety](write-safety.md#team-writes).

With authorization, `project transfer --to-team <uuid|same-service-link>` moves
the explicit `--project` or the Project resolved from the repository. The source
Team admin can transfer without destination membership. The command does not
change the default Team or repository binding. Review the preview and follow
[write safety](write-safety.md#project-transfers); a successful receipt may
report that the actor no longer has access.

## Project deletion

With explicit authorization for the target Project, `project delete` selects an
explicit `--project` or the Project resolved from the repository. The current
owner Team admin can delete it; active Worker claims block deletion. Deletion
makes the Project unavailable without a product recovery option while retaining
server history and files. Review the complete preview and follow
[write safety](write-safety.md#project-deletion).

## Register a project

With authorization, use `project create` to register the repository as a project.
It searches all accessible projects: a unique match is returned without Team
resolution, confirmation or a write; resolve identity first when the match is
ambiguous. For a new project, `--team <uuid|personal>` overrides the current
service/account default; an absent default selects Personal, while an invalid or
inaccessible default fails. Creation asks for confirmation, or accepts the
boolean `--confirm` for noninteractive use. Confirmation does not grant authority
or replace the service's membership and identity checks. Retain the returned
project ID, then read the project details to confirm the repository and name.

If the creation response is uncertain, establish the actual outcome first under [write safety](write-safety.md).
An identical name does not prove project identity.
Consult `daynight project --help` for available project configuration operations.
