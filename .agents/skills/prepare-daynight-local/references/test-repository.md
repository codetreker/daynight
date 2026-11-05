# Prepare the Test Repository and Command Router

## Choose and verify the repository

Before preparing a test environment, ask: "Which GitHub repository should be used
for the local test? Provide OWNER/REPO or its URL." An explicit choice in the
current request answers this question. For a retained environment, suggest its
recorded repository in the question and obtain the current choice before reuse.

Check the current `gh` account without displaying tokens, then verify the exact
repository supplied by the user:

```bash
gh repo view "$DN_GITHUB_REPO" --json nameWithOwner,url,sshUrl,defaultBranchRef,isEmpty
```

Use the returned canonical identity and an accessible clone transport. A missing
or inaccessible repository is an input/access problem, not authorization to
create a remote repository, change accounts or grant permissions. The test needs
at least one existing commit for Worker worktrees; an empty repository needs a
separate initialization decision.

When the user explicitly authorizes creating a test repository, use `gh repo
create` with the agreed owner and visibility after checking for an existing
repository. Reuse an accessible, nonempty repository without changing its
visibility merely because a newly created repository could be public. Initial
content and a push still need to fall within the user's initialization scope.

Choose an independent absolute checkout path, `DN_PLAYGROUND`, outside both the
Daynight source worktree and `~/.daynight-dev`. Prefer a clear sibling path when
the user has not selected one. Check its actual physical location and existing
use before creation. If absent:

```bash
gh repo clone "$DN_GITHUB_REPO" "$DN_PLAYGROUND" --no-upstream
```

If present, verify the effective `origin`, checked-out commit, changes and running
users before reuse. A same-named directory or same remote does not establish
exclusive ownership. Do not reset it, overwrite files, change its branch, or use
a stable Worker's checkout as the test checkout. Do not fetch dependencies or
run the repository's scripts merely to perform the routing smoke test.

## Isolate state and identify the local service

Use the host user's home directory to resolve `DN_DEV_ROOT` to the absolute
`~/.daynight-dev` path. Create it privately if absent and configure it under
[the refresh procedure](refresh.md#development-cli-configuration-and-worker).
Do not copy `~/.daynight` credentials, identity or databases. Do not change real
`HOME` or native Provider accounts. Verify the development root's physical path
does not equal, contain or sit inside the stable state directory; a symlink to
stable state is not isolation. Preserve an existing development root's
identity and records; it is one retained development environment, not a fresh
state root on every test.

Before starting a newer Worker against retained state, inspect the target
revision's SQLite admission and migration behavior. A nonempty unversioned
database may be reset rather than migrated; completed claims alone do not make
that reset a lossless update. Keep the old root, its journals and referenced
snapshots. When an isolated current-version test is within scope but retaining
the old environment prevents reuse, select and record a dedicated child such as
`~/.daynight-dev/localhost-verification-<run>`. Authenticate it against the local
service and use that exact root in the CLI, router and Worker. Check that no
running parent-root Worker manages the child or the same checkout. This verifies
a separate environment, not migration of the retained root; do not create a new
identity to bypass active executions or a shared scheduling pool.

Worker repositories and state cannot overlap in either direction, including
through symlinks. Use `DN_PLAYGROUND` as the Worker's explicit repository path
when practical. If a retained Worker has prepared another clone, verify that
binding and keep it independent; editing YAML does not move it.
Check the test checkout's existing `.daynight/project.yml` separately. A project
ID from a previous local database does not identify the new project's record.
Keep an unrelated binding intact and use explicit `--project` on fixture
commands; do not rely on automatic project discovery to repair it.

Before authenticated requests or fixture writes, parse the effective configuration
with the CLI's configuration parser or a YAML parser, inspecting only the origin
and credential presence. Require the agreed loopback origin (`localhost`,
`127.0.0.1` or `[::1]`, with its selected scheme and port); reject production
origins and credentials of unknown origin. A directory named `.daynight-dev`
does not prove localhost selection. Keep browser and CLI on the same public
origin, even when a Vite backend health probe uses another port.

## Create executable directory routing

The helper [create-repo-router.mjs](../scripts/create-repo-router.mjs) generates
a private `daynight`, optional `dn`, activation/deactivation scripts and nonsecret
metadata. It does not clone, change shell startup files, edit configuration or
contact Daynight. Set `DN_ROUTER_DIR` to a new output directory under the retained
Daynight source's `.tmp/local-development/`, outside the test checkout. After
verifying `DN_DEV_CLI` and the configuration root:

```bash
node "$DN_SKILL/scripts/create-repo-router.mjs" \
  --repo-root "$DN_PLAYGROUND" \
  --dev-root "$DN_DEV_ROOT" \
  --dev-cli "$DN_DEV_CLI" \
  --output "$DN_ROUTER_DIR"
. "$DN_ROUTER_DIR/activate.sh"
```

`DN_SKILL` is the absolute directory containing this skill. Add `--include-dn`
only when that command also needs routing. Repeat `--repo-root` for an explicitly
verified second development clone when ordinary shells need access there. Do not
include every clone of the same remote or an entire parent containing unrelated
repositories.

The helper refuses to overwrite an existing output. On a repeat run, inspect
the existing metadata and files and reuse matching routing. For changed roots
or configuration, generate a new output, source the known old router's
`deactivate.sh` in the affected shell, then source the new `activate.sh`. Remove
only the old activation line from persistent startup configuration. Deactivation
removes this router's PATH entries, including equivalent links, without deleting
its files. If it would leave no PATH entries, it fails without changing PATH;
restore a known ordinary command directory before retrying. Keep old files while
other shells use them. Confirm that no old router remains in the new launch
context: chaining routers can still send an outside call to an old development
repository.

The wrapper decides on every invocation using physical cwd. In the selected
root and descendants it sets `DN_CONFIG_DIR` only for the development child and
executes the selected `daynight-dev` entry with unchanged arguments. Outside,
it resolves the ordinary command from the current PATH after excluding itself.
It does not pin an old npm executable. Missing development executables fail
inside the scope instead of falling back to production.

Activation is idempotent and does not export a development root to the parent
shell. It keeps existing Daynight managed aliases ahead of the router. Inspect
shell functions and aliases that can shadow executables; do not silently delete
user definitions. Activate after NVM, direnv or other PATH setup. If a later
command prepends another `daynight` directory, source `activate.sh` again and
recheck routing; activation is not an automatic hook for subsequent PATH changes.
For persistent interactive use, add one identified source line after existing
PATH setup in the user's actual shell startup file within the environment-setup
scope, preserving all other content. Check a fresh shell after the edit. For a GUI or
independent Agent launch, explicitly activate the router in its launch context;
do not assume it inherits an unrelated terminal.

Keeping the router in PATH makes noninteractive `sh -c`/`zsh -c` calls that `cd`
into the repository work too. Outside the repository, `command -v daynight` may
still display the router; verify its actual delegate with a non-mutating command
such as `--version`, rather than requiring the path string to change.

Managed Agents use the development Worker's existing `agentCliAliases` and
explicit root, including in separately prepared worktrees. Those aliases pin the
Agent's original snapshot; directory activation must not replace them with the
mutable development entry. Verify the actual Agent, not only a simulated shell.

## Verify routing and skill reuse

Check the root, a nested directory, a similarly named sibling and a symlink
entrance. Exercise a noninteractive shell crossing the directory boundary and
confirm the parent's prior `DN_CONFIG_DIR` remains unchanged, including unset.
After NVM/PATH changes or replacement of a router, repeat the relevant inside and
outside checks in the actual launch context.
Within the test scope, `daynight --build-info` must identify the selected
development snapshot and its authenticated project read must reach localhost.
Outside, use version checks without business writes to confirm ordinary routing.

For an ordinary Agent, install the target bundle's `using-daynight` at Project
scope when needed, following [skill refresh](refresh.md#installed-skill), preserve
customized User copies and verify the loaded source after reload. Managed Agents
already receive the skill from their Worker's package. In both cases keep its
commands spelled `daynight`; no edited skill fork is required.

The helper's isolated regression checks use only fake executables and temporary
directories under the current Daynight worktree:

```bash
node --test "$DN_SKILL/scripts/create-repo-router.test.mjs"
```

They validate routing mechanics, not a real localhost or Provider connection.
