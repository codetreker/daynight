# Setup and projects

Use this when connecting, selecting a Project or managing account and Project
access. For every write, also read [write safety](write-safety.md).

## Concepts

A Project associates work with a Git repository. A Task belongs to one Project
and has its own status, metadata, dependencies, properties and materials. A Goal
is an objective represented by ordinary Tasks and their dependencies, not a
separate resource, status or command. A Step is an ordered Task-owned record;
a Thread is persistent discussion; a Session is an execution and its observed
activity. Attachments hold separate files. Worker assignments and claims identify
executions independently of the Task's human assignee and permission settings.

Project and Task IDs are complete UUIDs. Step IDs are exactly eight hexadecimal
characters, case-insensitive on input and lowercase on output; preserve leading
zeros. Replace command placeholders with actual IDs or values.

## Setup

Run `daynight --version` and `daynight --help` to inspect the installed CLI.
The [installation guide](https://daynight.cc/setup) covers installation and Agent
setup. Confirm the service and signed-in identity. Use `daynight login` when
authentication is needed and follow its browser verification prompts;
`daynight login --help` describes remote-terminal options. Keep credentials out
of chat. `daynight completion setup` configures shell completion.

`daynight` and `dn` accept the same commands. `daynight --skill` prints the complete
manual offline, without login, repository or configuration. `daynight skill
install` installs this skill for supported Agents and scopes; reload as instructed.
Worker setup is separate: ordinary Task operations do not require a Worker.

## Project discovery

```bash
daynight project list --json
daynight project show <project-id> --json
daynight project create "Example project"
daynight project create "Example project" --repo https://github.com/owner/repo.git --team personal --confirm
```

Within Git and its worktrees, Task commands normally match `origin` to an
accessible Project on the configured service. `--project <project-id>` overrides
that discovery for the invocation and also works outside Git. Verify the selected
Project with `project show`. If there is no match or several matches, establish
the repository, service and intended Project; do not guess an ID or register a
Project merely to make a query succeed.

Authorized `project create` uses the current origin unless `--repo` is supplied;
an explicit repository works outside Git. It searches all accessible Projects.
A unique equivalent repository returns the existing Project without resolving
a Team or asking for confirmation; multiple matches require selecting the
intended Project ID. Only new creation uses `--team <uuid|personal>`, the current
service/account default, or Personal when no default is saved. Invalid or
inaccessible defaults fail. New creation requires interactive confirmation or
`--confirm`; noninteractive creation requires `--confirm`. Retain the returned
ID and read the Project to verify its repository and name.

## Team context

Use `team list` for joined Teams, `team show` for one Team, and `team projects`
for its Projects. `--team <uuid|personal>` selects an explicit Team. Otherwise,
the CLI uses the default saved for the normalized service origin and account,
or Personal when no default exists. `team default show` validates and displays
that choice. Invalid or inaccessible defaults fail; listing Teams and explicitly
selecting a Team do not depend on the old default.

Authorized `team default set <uuid|personal>` validates membership and saves
the selection after interactive confirmation or `--confirm`. `personal` stores
the real Personal Team ID. It can replace an invalid old default. Cancellation,
identity mismatch or a concurrent credential/default change prevents saving.
Token rotation preserves the account's default. Team defaults do not change
Project discovery, explicit Project identity or Task identity.

## Team writes

Use `team create`, `team rename` and `team delete` for ordinary Team lifecycle
changes. Rename and delete resolve the explicit or default Team and read its
real name and version. Protect an earlier decision with that exact
`--if-version`; a supplied version differing from the read Team version fails
locally. Personal Teams cannot be renamed or deleted; deletion requires an
empty Team.

Writes need interactive confirmation or boolean `--confirm`. Team deletion's
interactive challenge is the displayed JSON string literal, decoded and matched
exactly against the raw name. `--confirm` skips the challenge but still submits
the real name and version. A noninteractive call without confirmation does not
write. Confirmation does not waive authorization or service preconditions.

Use `team member list` to obtain the target's membership version before
`team member set-role` or `team member remove`; `team leave` uses the current
user's membership version. Supply its exact `--if-version` for an earlier
decision. Team metadata and Project grant versions cannot replace it. A mismatch
with the current observation fails before writing. Membership changes also need
interactive confirmation or `--confirm`. Ordinary Teams retain an admin and
Personal membership is immutable. These operations do not change Project grants
or the saved default. A confirmed receipt reports the actor's remaining role;
self-exit does not require a later permission-sensitive Team read.

Current Team names or memberships cannot recover a lost original receipt, even
when they match the intended result. Apply [uncertain results](write-safety.md#uncertain-results).

## Invitations

Use `invitation inspect` to preview a same-service Project or Team invitation
for the current account without consuming it. Enter its link at the hidden
terminal prompt or use `--stdin`: at most 4096 bytes read to EOF, with at most
one trailing LF or CRLF. Never put invitation links or tokens in arguments,
flags, shell history, task content or logs. Invitation operations neither resolve
the default Team nor accept for another account.

Authorized `invitation accept` requires explicit confirmation; noninteractive
acceptance requires `--confirm` or sends no write. An existing direct relationship
preserves its role without consuming the invitation. Inherited-only Project
access still receives a direct member grant. Later membership reads cannot
recover an uncertain acceptance receipt.

## Project transfer

Authorized `project transfer --to-team <uuid|same-service-link>` moves the explicit
`--project` or repository-resolved Project. The source Team admin can transfer
without destination membership. Review the Project, source, destination and
expected actor access in the preview; confirm interactively or with `--confirm`.
The CLI submits observed ownership and destination versions with the current
identity. A conflict requires a new preview and decision. The operation changes
neither the default Team nor repository binding; grants and invitations remain
independent. A receipt can confirm success with no remaining actor access.
A later Project read, including 404, cannot prove an unknown transfer outcome.

## Project deletion

Delete only with explicit authorization for the selected Project. `project delete`
uses `--project` or repository discovery; the owner Team admin can delete it,
while active Worker claims block deletion. Deletion makes the Project unavailable
without a product recovery option, retaining server history and files.

Review the complete preview. Interactive deletion requires the displayed JSON
string literal of the name even with `--confirm`; noninteractive deletion requires
`--confirm`. The preview is an observation, not a version or identity condition
on DELETE. The service checks current permissions and active claims. The CLI
sends at most one DELETE. Only a validated receipt confirms deletion; a later
404 cannot establish an unknown original outcome.
