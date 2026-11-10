---
name: prepare-daynight-local
description: Use when preparing, refreshing or operating an isolated Daynight localhost environment — development CLI, local site, Worker, test repository, browser identity, managed CLI/website/Agent loops or `daynight controller` Test Sessions. Excludes deciding what to investigate, npm publication and production deployment.
---

# Prepare Daynight Local Development

Connect a known source revision to a local site, isolated development Worker and
Agents using canonical `daynight` commands, and operate them reliably. Every
local verification, reproduction or investigation builds on this environment.
Deciding what to investigate, judging findings and handing them off belong to
[discover-daynight-improvements](../discover-daynight-improvements/SKILL.md) and
its topic skills. Keep local fixtures, production delivery and skill maintenance
separate.

Links that leave the skills directory refer to the Daynight repository. When this
skill is installed outside a checkout, resolve such links against the selected
Daynight source checkout.

## Choose the workflow

Read the selected checkout's `AGENTS.md` and only the references needed for the
requested result. Reuse an established environment after verifying its identity;
an investigation is not a request to rebuild it.

| Requested result | Guidance |
| --- | --- |
| Prepare or refresh | Inventory below, [test repository and routing](references/test-repository.md), [refresh](references/refresh.md), [verification](references/verification.md) |
| Test identity or background browser | [Local identity](references/local-identity.md); selected browser in an isolated headless instance, default Edge |
| Complete CLI/website/Agent loop | [Local test loop](references/local-test-loop.md), [website controls and readback](references/website.md) |
| Run a standalone Session with a native Provider | [Controller Test Sessions](references/test-sessions.md) |
| Create local data or runtime fixtures | [Fixtures](references/fixtures.md) |
| Capture or record page state | [Browser evidence](references/browser-evidence.md) |
| Let other agents use the environment, or change it while they may | [Shared use](references/shared-use.md) |
| Find problems, improvements or requirement candidates | [discover-daynight-improvements](../discover-daynight-improvements/SKILL.md) with its topic skill |

The [development guide](../../../docs/development.md#local-development-cli-channel)
owns maintained build and runtime mechanisms. This skill connects them; it does
not implement another deployment manager.

## Establish the requested result

Preparing a test environment includes the complete localhost test loop by
default. An explicit inspection, build-only or update-only request ends at its
requested layer; inspection stays read-only. Editing this skill does not operate
the environment. Within an authorized preparation or update, perform necessary
operations without asking again for each command; resolve missing resource
ownership or the treatment of active executions before the affected operation.

Keep environment-work records local; do not register Daynight tasks or upload
attachments to track preparation itself. A requested complete test loop may
create one bounded acceptance task and its evidence in the selected localhost
test project. These are test fixtures, not environment-work tracking. No
production Daynight records or GitHub writes are part of that loop. Production
improvement tasks come from an authorized investigation under
discover-daynight-improvements.

Before preparing a test environment, first ask which GitHub repository to use
(an `OWNER/REPO` or URL), unless the current request already supplies that choice.
A retained environment's repository can be suggested in the question, but is
not a substitute for the user's choice. Do not infer it from the Daynight source
checkout or an old playground.
Follow [test repository preparation](references/test-repository.md) to verify it
with `gh`, clone or reuse an independent checkout, and install directory routing.

Use `~/.daynight-dev` as the explicit development configuration and state root.
It remains separate from `~/.daynight` and from the test repository. Worker
rejects physical ancestor/descendant overlap between state and its repositories,
including symlinks; do not put `.daynight-dev` inside its checkout.
Preserve an incompatible retained environment; the
[state-isolation procedure](references/test-repository.md#isolate-state-and-identify-the-local-service)
describes when a separately identified verification root is appropriate.

## Inventory before changing resources

Resolve actual paths and owners instead of assuming a sibling checkout, port,
executable name or branch identifies the environment. Capture these observations
in a private, Git-ignored `.tmp/local-development/environment.md` under a retained
development worktree when preparing or updating; for inspection, report them
without creating files. This record holds resource identity and recovery inputs,
not secrets or a task tracker.

| Resource | Record and verify |
| --- | --- |
| Source | Physical checkout path, selected full commit, branch and dirty state; whether that checkout will remain available |
| Toolchain and downloads | Actual Node/pnpm/Go executables and versions against the selected revision, configured registry/mirror, Docker mode if used, available disk for builds and retained snapshots |
| CLI | Stable and development command resolution; `daynight-dev --build-info`, fixed Node executable and previous snapshot |
| Site | Exact public and backend origins, native/Compose/Vite mode, PID or container identity, executable/image, cwd, launcher or supervisor, logs and prepared versus running artifact |
| Persistent services | Database and file-storage ownership, paths or volume names, private configuration location, UniAuth fixture or real gateway, registered callback origin and selected test persona; available paired backup |
| Development state | Absolute `DN_CONFIG_DIR`, service origin, credential presence and known origin, Worker identity, cloud enrollment/target and active executions; never token values |
| Other users | Online Test Sessions, Controllers using the development root and other agents' fixtures, checked under [shared use](references/shared-use.md) |
| Repositories | Confirmed GitHub identity, independent test checkout and local project binding; Worker root, explicit paths and persisted prepared bindings, checked for overlap with state or another Worker |
| Agent entry | Provider and mode, installed skill scope, terminal wrapper or hook, Agent aliases, and whether each process predates the new build |

Read only the needed configuration fields. Do not print complete config files,
process environments, Docker inspect/config output, or credential-bearing URLs.
Record private file locations and credential presence instead. An unknown owner
or origin is a concrete gap, not permission to create replacements.

## Prepare and update

Follow [the refresh procedure](references/refresh.md) for the chosen runtime.
Keep the existing native or Compose mode unless changing it is part of the task.
Use the target revision's maintained installer, build commands and deployment
files.
After local service and credential checks pass, prepare the test project's
directory router as described in [test repository preparation](references/test-repository.md).

The important boundaries are:

- A stable Worker with an Agent alias remains a stable Worker. Launch the actual
  development Worker from the target development snapshot and explicit state root.
- `DN_CONFIG_DIR` isolates Daynight configuration and companion state. It does not
  isolate repository worktrees, project `.daynight`, installed skills, Git/SSH,
  Provider accounts/history or data on a shared server. Keep development Worker
  checkout paths separate from stable Worker paths.
- `pnpm dev:install` changes the development entry, not running processes or
  installed skill copies. Retained Agents can still require their old snapshot.
- A healthy site can be an old binary. A successful CLI query can use a different
  source revision from the Worker. Verify each component's identity independently.
- The canonical local UniAuth fixture supplies normal browser Sessions and CLI
  PATs without interactive sign-in; it preserves authentication and permission
  checks. Real OAuth/device consent are separate checks. Keep the user's ordinary
  browser profiles, windows and focus undisturbed.
- Other agents may be using a retained environment. Check for them under
  [shared use](references/shared-use.md) before stopping or replacing a component.

## Verify and hand back

Use [verification and recovery](references/verification.md) to report installed,
running and tested components separately. State the exact source and origin,
what changed, observed results, retained resources and any incomplete layer.
Do not describe configuration or HTTP checks as a completed Agent task test.
For a requested complete test, follow [the localhost loop](references/local-test-loop.md):
CLI creation, website readback and enablement, CLI observation, managed Agent
execution through canonical `daynight`, and result confirmation in both clients.
Use [the website guide](references/website.md) for the real navigation, task and
Worker controls, Session View and attachment readback. Browser exploration can
proceed read-only before a test repository is chosen; dispatch still requires
the selected repository and scheduling checks.

Script success establishes only its documented checks, not a good design,
accessible product or completed implementation. Investigations that use this
environment report under discover-daynight-improvements.

Keep long-lived build worktrees, snapshots and configuration needed by the
environment. Remove only task-owned temporary probes whose users have stopped.
Publishing the skill, merging repository changes, updating production or deleting
persistent data remains governed by the task's own scope and repository rules.
