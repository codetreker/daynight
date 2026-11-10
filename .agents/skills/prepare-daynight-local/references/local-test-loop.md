# CLI, Website and Worker Test Loop

Use this procedure to complete test-environment preparation or an explicit
localhost test request. Preparation work remains recorded locally. The single
acceptance task below and its attachment
are deliberate localhost fixtures. They do not authorize production task changes,
GitHub commits/PRs, deployment of business code, or unrelated work selection.
Preparing the pinned UniAuth fixture and cloning the test repository can use
GitHub; the native model Provider can also be external. Default sign-in uses
the local test identity rather than a real GitHub account. A "localhost loop"
is not an offline operation.

## Admit the exact environment

Complete [repository and routing setup](test-repository.md) and the applicable
[verification layers](verification.md). Record the selected source SHA, dev
snapshot, absolute `~/.daynight-dev` root, exact loopback public origin, canonical
GitHub repository, physical checkout and expected Worker identity. Recheck the
effective origin before each write phase; keep all CLI calls scoped explicitly
to this root and IDs read from this local service. Never use a production bookmark
or copied project/task ID.

Prepare [the local test identity](local-identity.md), a CLI PAT and an isolated
headless browser context for the same persona; verify that both return the same
local user ID. Use the selected browser, including Edge when requested, without
reading its ordinary profile or opening a visible window. The canonical helpers
perform authentication preparation, so this loop does not wait for interactive
GitHub sign-in or CLI authorization. Real OAuth/device-flow coverage is an
optional, separately requested layer.

Perform the website leg through actual page controls after authentication.
A direct API write cannot substitute for it. Follow [the website guide](website.md)
for navigation, focus/visibility diagnostics and controls; its read-only exploration
does not require dispatching a task. Report a missing browser leg accurately
instead of treating successful credential setup as UI acceptance.

If retained preview state requires a separate verification root, use the exact
root selected by the repository reference throughout this loop. Do not revert to
the launcher's default root between commands.

Discover or register the selected repository on this local service. Set
`DN_REPO_URL` to the canonical `url` returned by the repository check:

```bash
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" project list --json
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" project create "Local test" \
  --repo "$DN_REPO_URL" --team personal --confirm
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" project show "$DN_PROJECT_ID" --json
```

Use the returned local project ID. Creation reuses a unique existing repository
match; multiple matches require selecting the intended existing project. Do not
create duplicates on uncertain responses. `project create` has no `--json` flag.
Do not register a tracking project for the Daynight maintenance work itself.

## Prepare the intended development Worker

Configure local `agentControlMode: web`, independent paths and aliases in the
explicit root; use the verified test clone's `remote`, `path` and `projectId`.
For first enrollment, the candidate selects Codex, concurrency one, and only the
test Project. For an enrolled Worker, inspect the localhost My Workers
configuration: Agent, model/arguments, Projects and scheduling are cloud-owned.
Verify the relevant items are applied/effective, not merely saved or reported
online. Preserve an enrolled Worker's existing Project list; replacing it with
only the test Project can interrupt existing executions. `worker show` reports
observations, not the cloud configuration document.

Before starting or reusing a Worker, inspect its complete selected Project list
and task inventory, including active claims. A Worker can execute eligible tasks
in any selected Project. The test pool must belong to this test, have no unrelated
eligible tasks or retained executions, and remain reserved during the bounded
run. A single empty inventory is insufficient for a shared pool where other
users, Workers or triggers can make unrelated work eligible. If the selected
revision provides a narrower scheduling restriction, verify that it actually
limits this Worker to the fixture. Otherwise, a shared or uncertain pool leaves
the environment prepared with dispatch pending. Do not change other tasks,
remove existing Projects, reset the Worker or create another identity to bypass
this boundary.

Start or reuse the verified development Worker through its selected launch method:

```bash
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" worker run
```

The launch must inherit the user's established native Provider environment;
verify only the effective provider/model, its configured `env_key` and whether
that variable is nonempty. Follow
[native environment and recovery](refresh.md#native-provider-environment-and-retained-executions)
when an automation shell differs from the user's terminal. The Daynight PAT and
the native Provider credential are independent. Preserve the original claim and
Session if a missing environment requires a normal Worker restart; restarting
does not replay a confirmed bootstrap or automatically retry a failed turn.

Confirm the actual prepared repository path and that no other compatible Worker
can take this fixture. Use Worker targeting if the selected revision explicitly
supports it; otherwise require an unambiguous local test pool. Platform alone
does not select a machine. Do not stop unrelated Workers or remove their Projects
to manufacture exclusivity. If a protected task is running, follow the retained
execution rules instead of interrupting it for this test.

## CLI creates; the website reads and enables

Choose a unique `DN_RUN_ID` and a finite observation budget before dispatch.
Write a complete acceptance description in a local temporary file, then pass its
contents as one CLI argument. It must specify:

- This run's marker, expected localhost origin, Project ID, development root and
  source SHA; use only this original assignment and localhost fixture.
- Type: acceptance. No source edits, dependency installation, Git commits,
  pushes, PRs or production mutations are required.
- Use canonical `daynight` to inspect command resolution, build metadata, the
  project and the assigned task. Confirm the original claim and actual worktree.
- Upload a concise `acceptance/result.md` to this task, with the marker, observed
  source/version/root, actual command results and pass/fail judgments. Do not
  include tokens, full configuration or native account data.
- Read back the attachment and complete the original claim using the managed
  assignment runtime contract and the task's acceptance criteria. Do not invent
  another task or report success from simulated output. Report failures through
  that contract.

For example, from a shell with the description loaded into `DN_TEST_DESCRIPTION`:

```bash
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" task create \
  --title "Local test $DN_RUN_ID" --description "$DN_TEST_DESCRIPTION" --status todo \
  --project "$DN_PROJECT_ID"
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" task show "$DN_TASK_ID" \
  --project "$DN_PROJECT_ID" --json
```

Creation defaults to the authenticated account, `proposed` and `allowAgents=false`; this confirmed test-loop task explicitly selects todo.
There is no create `--allow-agents` or `--json` option. Do not set `in_progress`;
Worker must perform the real claim. Record the confirmed task ID immediately.

Open the local `/projects/PROJECT_ID/tasks/TASK_ID` page. Check the unique marker,
description, account, status and disabled automatic execution. This proves the
website displays the CLI-created fixture. On that page enable automatic execution
and complete its confirmation dialog, then read the task with the CLI again.
Confirm `allowAgents=true`; it may already be claimed, so do not require it still
be `todo` or its version to have advanced by exactly one. This is the website-to-CLI
leg, and must be observed through the actual website.

## Observe the actual Agent and both results

Monitor this fixture with bounded reads. Verify the observed claim's Worker
matches the expected development Worker. The managed Agent's startup prompt
supplies the original assignment and self-contained runtime constraints; the
coordinator does not create a substitute ordinary session or complete the task
for it. The Agent uses `daynight --skill` for product operations and follows the
target repository's applicable rules for delivery.

Inside that actual Agent, the required canonical calls include:

```bash
command -v daynight
daynight --build-info
daynight project show "$DN_PROJECT_ID" --json
daynight task show "$DN_TASK_ID" --project "$DN_PROJECT_ID" --json
```

Agent variables must come from the supplied assignment and test inputs; do not
assume coordinator shell variables are inherited. Before business writes, the
Agent verifies the current task, original active claim, Worker and actual worktree.
After delivery and acceptance, it reads back evidence, rereads the task, verifies
the original assignment, and submits `done` with the original claim ID and exact
observed version as the final task mutation. A rejected or unknown write requires
observation before another decision; never automatically replay it or fall back to
ordinary completion. When necessary human intervention cannot be supplied within
the assignment's authority, the Agent pauses its own task and confirms the pause;
it verifies resolution and authorization before clearing the pause and reading it
back. Pending review or CI remains an ordinary wait. Preserve the controller-owned
worktree, branch and workspace throughout.

From the coordinator, read the task and `acceptance/result.md` with the explicit
development CLI/root. In the website, verify the same task is done and open the
same attachment. Require the run marker and actual routing/build evidence to
agree, and confirm `properties.worker.state=completed` retains the original
claim. Session View is useful supporting evidence for the real Agent execution.
Do not infer archive completion or worktree deletion solely from task completion.

Full success requires every leg: CLI creation → website read/enablement → CLI
readback → expected Worker/Agent execution → canonical development CLI → result
readback in CLI and website. A shell fixture, online Worker or API-only test
cannot stand in for a missing leg. If the budget expires or a response is lost,
reconcile the existing IDs and report the incomplete stage; do not create another
fixture, force completion, or claim continued monitoring after stopping.

Retain the localhost task and attachment for inspection by default. Delete only
when cleanup was requested, after confirming no active claim and reading the
latest version. Task deletion is soft deletion, not storage erasure. Do not
delete Worker-managed worktrees, reset identity/state, or clear shared data as
test cleanup. Keep the long-lived environment available unless stopping it was
part of the requested result.
