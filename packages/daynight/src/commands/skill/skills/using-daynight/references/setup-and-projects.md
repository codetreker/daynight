# Setup and projects

For connection, Project selection and account/Project access. Every write also
requires [write safety](write-safety.md).

## Concepts

| Object | Meaning |
| --- | --- |
| Project | Work associated with a Git repository. |
| Task | One Project's ordinary work item (`type=task`) with status, metadata, dependencies, properties and materials. |
| Goal | A typed objective resource (`type=goal`, `parentId=null`). This CLI exposes no Goal creation or parent-change options. |
| Step | Ordered Task-owned record. |
| Thread | Persistent Task discussion. |
| Session | Execution and its observed activity. |
| Attachment | Separate file. |
| Worker assignment/claim | Actual execution identity, independent of human assignee and permission settings. |

Project/Task IDs are complete UUIDs. Step IDs are exactly eight hex characters:
case-insensitive input, lowercase output, significant leading zeros. Replace
command placeholders with actual IDs/values.

## Setup

Inspect the installed CLI with `daynight --version` and `daynight --help`.
The [installation guide](https://daynight.cc/setup) covers installation and Agent
setup. Confirm service and signed-in identity. For authentication, run
`daynight login` and follow browser verification; its `--help` covers remote
terminals. Keep credentials out of chat. `daynight completion setup` configures
shell completion.

`daynight` and `dn` are equivalent. `daynight --skill` prints this complete manual
offline without login, repository or configuration. `daynight skill install`
installs for supported Agents/scopes; follow its reload instructions. Ordinary
Task operations need no Worker; Worker setup is separate.

## Project discovery

```bash
daynight project list --json
daynight project show <project-id> --json
daynight project create "Example project"
daynight project create "Example project" --repo https://github.com/owner/repo.git --team personal --confirm
```

In Git/worktrees, Task commands match `origin` to an accessible Project on the
configured service. `--project <project-id>` overrides discovery per invocation
and works outside Git. Verify with `project show`. For no/ambiguous matches,
establish repository, service and intended Project; never guess IDs or register
merely to make a query succeed.

Authorized `project create` searches all accessible Projects using current origin
or explicit `--repo` (also outside Git):

| Result | Behavior |
| --- | --- |
| Unique equivalent repository | Return existing Project without Team resolution or confirmation. |
| Multiple matches | Select the intended Project ID. |
| New Project | Use explicit `--team <uuid\|personal>`, else service/account default, else Personal. Invalid/inaccessible defaults fail. Confirm interactively or with `--confirm`; noninteractive creation requires it. |

Retain the returned ID; read back the Project to verify repository and name.

## Team context

`team list` reads joined Teams, `team show` one Team, `team projects` its Projects.
Explicit `--team <uuid|personal>` wins; otherwise use the normalized
service-origin/account default, or Personal if absent. `team default show`
validates/displays it. Invalid/inaccessible defaults fail; listing or explicit
selection does not depend on the old default.

Authorized `team default set <uuid|personal>` validates membership, then saves
after interactive confirmation or `--confirm`. `personal` stores the real
Personal Team ID; an invalid old default can be replaced. Cancellation, identity
mismatch or concurrent credential/default change prevents saving. Token rotation
preserves the default. Defaults affect neither Project discovery nor explicit
Project/Task identity.

## Team writes

`team create`, `team rename` and `team delete` manage ordinary Teams. Rename/delete select the
explicit/default Team and read its real name and metadata version; a supplied
version differing from that read fails locally. Personal Teams cannot be renamed
or deleted; deletion requires an empty Team.

Team writes require interactive confirmation or boolean `--confirm`; without
confirmation, noninteractive calls do not write. Team deletion's interactive
challenge is the displayed JSON string literal decoded and matched exactly to
the raw name. `--confirm` skips the challenge but still submits real name/version;
confirmation waives neither authorization nor service preconditions.

For `team member set-role` or `team member remove`, obtain the target membership version through
`team member list`; `team leave` uses the current user's membership version.
Team metadata/Project grant versions cannot replace it; mismatches with the
current observation fail locally before writing. Membership changes preserve
Project grants and saved defaults, retain an ordinary Team admin and refuse
Personal membership changes. Confirmed receipts report the actor's remaining
role; self-exit needs no later permission-sensitive Team read.

Matching current names/memberships cannot recover a lost receipt. Follow
[uncertain results](write-safety.md#uncertain-results).

## Invitations

`invitation inspect` previews a same-service Project/Team invitation for the
current account without consuming it. Enter its link at the hidden prompt or
through `--stdin`: at most 4096 bytes read to EOF, with at most one trailing
LF/CRLF. Never put invitation links/tokens in arguments, flags, shell history,
Task content or logs. These operations neither resolve default Team nor accept
for another account.

Authorized `invitation accept` requires explicit confirmation; noninteractive
calls without `--confirm` send no write. Existing direct relationships retain
their role without consuming the invitation; inherited-only Project access still
gets a direct member grant. Later membership reads cannot recover an uncertain
acceptance receipt.

## Project transfer

Authorized `project transfer --to-team <uuid|same-service-link>` moves the explicit
`--project` or repository-resolved Project. Source Team admins need no destination
membership. Review Project, source/destination and expected actor access in the
preview; confirm interactively or with `--confirm`. The CLI submits observed
ownership/destination versions with current identity; conflicts require a new
preview/decision. Defaults and repository binding stay unchanged; grants and
invitations remain independent. A receipt can confirm success without remaining
actor access; later Project reads, including 404, cannot prove an unknown outcome.

## Project deletion

Explicitly authorized owner Team admins may `project delete` the explicit
`--project` or repository-resolved Project; active Worker claims block it.
Deletion retains server history/files but makes the Project unavailable without
a product recovery option.

Review the complete preview. Interactive deletion requires the displayed JSON
string literal of the name even with `--confirm`; noninteractive deletion requires
`--confirm`. The preview supplies no version/identity condition on DELETE;
the service checks current permissions/claims. The CLI sends at most one DELETE.
Only a validated receipt confirms deletion; a later 404 cannot prove an unknown
original outcome.
