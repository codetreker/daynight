# Refresh the Local Environment

Read only the runtime branch in use. The
[development guide](../../../../docs/development.md#local-development-cli-channel),
[native server guide](../../../../packages/daynight-server/README.md#build-and-run)
and [localhost deployment guide](../../../../deployment/localhost/README.md)
own the commands and configuration. Recheck their target-revision content when
it differs from these examples.

## Select source and prepare artifacts

For a request for latest main, fetch `origin/main` once and record its full SHA.
Use a dedicated, retained worktree at that commit. Reuse a suitable build worktree
after checking its changes and process use; do not reset unrelated edits or move
the primary checkout. For a specified revision, use that revision. Record dirty
builds as such; they are not reproducible main builds. When the target branch
moves during long work, refresh again with this procedure; an investigation
rechecks its findings against the new revision under its own freshness rule.

Use these names for resolved, absolute paths in the command examples:

| Variable | Meaning |
| --- | --- |
| `DN_SOURCE` | Retained source worktree at the selected revision |
| `DN_DEV_ROOT` | Absolute path to the user's `~/.daynight-dev`, or a separately identified verification root when preserving incompatible state; outside all Worker repositories |
| `DN_BIN_DIR` | Chosen development launcher directory, available to the launching shell |
| `DN_DEV_CLI` | The installed `$DN_BIN_DIR/daynight-dev` entry |
| `DN_SERVER_BINARY` | New, unused output filename under the retained worktree's `.tmp/` |
| `DN_PLAYGROUND` | Separate business repository used for local tests |

Check the selected source's toolchain pins. The development installer currently
requires Node.js 24 and macOS/Linux; use the repository's pinned pnpm version.
Windows development installation and Agent aliases are unsupported. Source
`packages/daynight-server/scripts/env.sh` only in a Bash subprocess: it creates
cache directories and changes Go, `TMPDIR` and XDG variables. These settings must
not leak into the shell that starts native Providers or the Worker.

From `DN_SOURCE`, install dependencies once with `pnpm install --frozen-lockfile`.
Preserve the chosen registry; a one-command mirror override is sufficient when
requested. Docker builds require their own `DAYNIGHT_NPM_REGISTRY`, regardless of
the host npm configuration. Do not globally change npm settings for one build.

Build before stopping a working environment. Keep the old binary/image and CLI
snapshot. Read source changes affecting migrations and compatibility before
cutover. If updating a nonempty database, use the existing paired-backup procedure
and account for all writers; a saved executable alone is not a data rollback.
When a native site's PostgreSQL runs in a container, take the dump with that
container's `pg_dump` if the host client is older than the server; an older
client refuses to dump a newer server. Pass the password through the environment
without printing it, write a custom-format dump into the private backup
directory, check its `PGDMP` header, and record file sizes and SHA-256 hashes
alongside the matching storage and development-state copies.

An old preview database may contain an unpublished migration whose number was
later used differently on main. If startup rejects its ledger, compare the
recorded checksums and actual schema with the selected source using read-only
queries. Do not rewrite the ledger or skip migrations to make startup succeed.
Retain the old database and storage together. An authorized disposable test may
use a separate clean database and storage directory; record that as a new test
environment, not a successful upgrade of the retained environment. Its local
accounts, tokens, projects and Worker enrollment must be established separately.

## Native site

Build the embedded UI and a new server artifact from the same source:

```bash
cd "$DN_SOURCE"
pnpm web:build
mkdir -p "$(dirname "$DN_SERVER_BINARY")"
bash -c 'set -e
  cd "$1/packages/daynight-server"
  source scripts/env.sh
  go build -o "$2" ./cmd/daynight-server
' _ "$DN_SOURCE" "$DN_SERVER_BINARY"
```

Keep the build SHA and a hash of the output with the artifact. Inspect and reuse
the existing private runtime configuration and supervisor/foreground launch
method. Retain its database, storage and origin. For the default test-identity
environment, prepare the maintained UniAuth fixture and its private registration
with [local identity setup](local-identity.md) before starting the server.
Keep an existing real-OAuth environment separate when changing its gateway would
affect other users or retained executions; changing a gateway does not migrate
accounts, tokens or task ownership.
Do not overwrite an in-use executable, guess a command from a PID alone, or treat
another Docker service such as UniAuth as the Daynight server.

Inspect active development executions, and other agents using the environment
under [shared use](shared-use.md#check-for-users-before-changing-the-environment),
before stopping the exact old Worker and site. Use their normal shutdown paths
within the authorized scope, preserving
claims, journals and native sessions. If treatment of a running task is unresolved,
finish preparing artifacts and leave cutover pending; do not force-withdraw it
to make an upgrade appear complete. Start the new server through the selected
launch method, retaining useful failure logs and the old artifact on failure.

`pnpm web:dev` starts Vite only. An existing Vite development arrangement also
needs its actual Go backend, database and authentication/proxy configuration;
updating Vite does not update those components. Record the backend origin from
the selected Vite proxy configuration and actual Go listener separately from
the browser origin. Vite does not proxy `/healthz` or `/readyz` by default.

### WebSocket routing through Vite

Inspect the selected revision's `/api` proxy before testing Web mode. An HTTP
`target` without `ws: true` does not establish WebSocket Upgrade forwarding.
The page and CLI can work while a Controller repeatedly reports
`Opening handshake has timed out`. Confirm the actual request path and failure;
the message alone does not identify the proxy as its cause.

When that setting is missing, an owned override can retain the source
configuration and enable Upgrade handling. For a file at
`$DN_SOURCE/.tmp/local-development/vite.config.mts`, where the selected
revision defines `/api` as an object:

```typescript
import base from '../../packages/daynight-web/vite.config.ts';

const proxy = base.server?.proxy ?? {};

export default {
  ...base,
  server: {
    ...base.server,
    proxy: { ...proxy, '/api': { ...proxy['/api'], ws: true, changeOrigin: false } },
  },
};
```

The override extends the source object instead of importing Vite. Vite bundles
relative configuration imports, so importing its own distribution through
`node_modules` emits unresolved-import warnings on every start.

Start Vite with this explicit `--config` through the existing owned launcher and
retain its public hostname and port. Keep `changeOrigin: false`; do not enable
`rewriteWsOrigin` or rewrite the browser Origin to bypass server checks. Preserve
the callback route and other proxy settings. The
[Vite proxy documentation](https://vite.dev/config/server-options.html#server-proxy)
describes these options.

Alternatively, use the embedded UI build above and bind the Go server directly
to the same public origin. This removes the development proxy hop while keeping
the CLI, browser, authentication callback and Session URLs aligned. Stop only
the owned listener being replaced; retain database, storage and identity. A
private override is an environment aid, not a delivered product fix. Verify the
real Session connection and progress after either route; HTTP readiness alone
does not cover Upgrade forwarding.

## Compose site

Inspect the actual Docker context, existing containers and volume ownership.
The localhost stack has fixed container names. A different Compose project name
does not permit a second copy on the same Docker daemon, and may select different
data volumes. Preserve the existing project identity during refresh.

On first setup only, prepare the private `.env` from the selected source's
template. On update, preserve existing settings and fill only required additions.
Keep the public origin, port and registered UniAuth callback consistent. Reuse
credentials only for the intended service; never print expanded Compose config.
The default test-identity workflow still needs the maintained fixture reachable
from the server's network namespace. A host-loopback fixture URL is not container
loopback. Verify that routing before selecting Compose for the test; do not
disable authentication or reconfigure a shared real gateway to avoid it.
Do not replace an existing file with `.env.example`.

After preparing the active-execution and backup requirements, use the maintained
entry point from `DN_SOURCE`:

```bash
bash deployment/localhost/up.sh
```

When Tencent's npm mirror is selected, the corresponding command is:

```bash
DAYNIGHT_NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/ bash deployment/localhost/up.sh
```

This rebuilds and recreates the whole stack with its health timeout, preserving
the database and attachment volumes. Recreate gateway and server together as the
script does; they share a network namespace. It is not an inspection command or
a way to refresh an unrelated native site. Build time is outside its 120-second
readiness wait. Do not use `down --volumes` for an update.

## Development CLI, configuration and Worker

Before installation, record the existing development entry's real target. From
the selected source, run:

```bash
pnpm dev:install --bin-dir "$DN_BIN_DIR"
"$DN_DEV_CLI" --build-info
```

For a standalone native pnpm installation, inspect the selected installer's
package-manager invocation first. Versions that run `npm_execpath` through Node
require a JavaScript entry; a Node syntax error while reading the native pnpm
binary indicates this mismatch. With Node.js 24 and the pinned pnpm on PATH,
invoke the same maintained installer outside that inherited lifecycle environment:

```bash
env -u npm_execpath node scripts/dev-install.mjs --bin-dir "$DN_BIN_DIR"
"$DN_DEV_CLI" --build-info
```

This changes only the invocation; do not treat a failed install as a published
snapshot or replace the global package manager to bypass it.

Check source directory, commit, dirty state, snapshot directory and fixed Node
executable against the target. `daynight-dev update` refuses npm updates.
Installation switches the launcher atomically; it does not switch the entire
environment atomically. Account for service/CLI compatibility and prevent new
development executions during an incomplete cutover. If a protected active task
prevents normal shutdown and no supported quiescing mechanism is available, keep
the environment at the preparation stage. Building new artifacts does not stop
the old Worker from claiming another task; do not report it as drained. Removing
cloud Project selections can stop their existing executions, so it is not a
non-interrupting drain mechanism.

Every development command uses an explicit root, even if the launcher has a
default. Inherited `DN_CONFIG_DIR=$HOME/.daynight` would otherwise select stable
state. Merge the required settings in `$DN_DEV_ROOT/config.yml`, preserving other
fields and the existing development Worker identity. The configuration follows
the [configuration manual](../../../../packages/daynight/README.md#configuration-root):

```yaml
serverUrl: http://127.0.0.1:5173
agentCliAliases:
  daynight: /absolute/bin/daynight-dev
  dn: /absolute/bin/daynight-dev
worker:
  agent: codex # Initial enrollment candidate only.
  agentControlMode: web
  repositoryRoot: /absolute/separate/dev-repositories
```

Substitute the observed origin and chosen absolute paths; `5173` is only an
example. Map `dn` only when needed; mapping `daynight` does not map it implicitly.
Check every explicit `repositories[].path`, `repositoryRoot`, and already
persisted prepared repository binding. Worker startup prefers the previous
binding's `localPath`; editing YAML or the root does not migrate it. Confirm
actual paths before claiming isolation, and do not delete binding/claim state
to force relocation. Do not point two Workers at the same checkout/worktrees.
Preserve real `HOME` and native Provider accounts.

For managed dispatch, read
[Worker configuration and startup](../../../../packages/daynight/README.md#worker-configuration-and-startup).
The YAML Agent/model/arguments, Project selection and scheduling values are only
the first-enrollment candidate when no cloud target exists. An enrolled Worker's
cloud target owns those values; local YAML cannot override it. On the intended
local site's My Workers page, inspect and, when in scope, change the desired
configuration, then verify its applied/effective observation. An empty cloud
Project selection can leave an online Worker unable to claim any task.
Credentials, identity, repository paths and `agentControlMode` remain local.
Ordinary Agent execution requires none of these managed settings; do not change
them merely to launch a standalone Codex conversation.

Keep same-origin development credentials. Never copy stable config/state into
the development root. A `serverToken` has no separate origin binding in config:
when the origin changes or the credential's origin is unknown, remove that token
from the selected private config before any authenticated request to the new
origin. For default localhost acceptance, use the canonical test-identity helper
to create a same-persona PAT and merge it into this private configuration as
described in [local identity setup](local-identity.md#authenticate-the-cli-and-browser).
Keep credential files private (normally `0600`) and verify the effective user
ID in both clients. This preparation needs no interactive `daynight-dev login`.

When real OAuth or device authorization is the requested test, follow the
separate [real-login procedure](local-identity.md#optional-real-oauth-and-device-authorization).
Keep secrets out of chat and preserve stable accounts in either mode.

When managed dispatch is requested, start the development Worker from the verified
development entry after the site, root and local project checks pass, using its
selected long-running launch method. For test dispatch, first verify the complete
Worker scheduling scope under [the local test loop](local-test-loop.md#prepare-the-intended-development-worker);
starting a Worker can immediately claim other eligible tasks in any selected
Project. Preserve the user's established native Provider environment as described
below; an automation shell may lack variables available in their interactive
terminal:

```bash
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" worker run
```

### Native Provider environment and retained executions

Daynight's configuration root does not configure native Provider authentication.
Launch the Worker through the user's established environment, retaining real
`HOME`, native Provider paths and required exported variables. Do not carry the
Go build subprocess's cache or home-related overrides into this runtime. For
Codex diagnosis, inspect only the selected provider, model and its `env_key`;
check whether that named environment variable is nonempty in the actual launch
context. Report the name and presence boolean, never the value. Do not read
`auth.json`, dump a complete config or print process environments. An absent
`env_key` does not prove authentication is absent: the Provider may use its
ordinary native credential mechanism.

A working CLI task query proves the Daynight PAT works, not that Codex can reach
its model Provider. If a required native variable is missing, restore the
established launch environment, for example through the user's existing
interactive-shell setup, without copying its secret into the skill, task,
command arguments or evidence. Check presence again before starting the Worker.
Do not change the model or account merely to make the test pass.

For a recoverable Web execution, use normal Worker shutdown and restart with the
same configuration root after reconciling the original task and stop proof.
Preserve Worker identity, claim, journal and native session. A replacement
Controller generation can increase while the execution, Session, claim and
native session IDs remain the same. Confirm those identities from the actual
observations before calling it a resume. Do not reset state, force-withdraw the
claim or create another task to repair a missing environment variable.

Recovery is not turn replay. When the journal records
`initialInputState=confirmed`, bootstrap input must not be sent again. A native
turn that already failed is not automatically retried by Worker restart. If
another turn is authorized, send the necessary continuation once through the
existing Session controls and reconcile its outcome before resending. Retained
state alone does not prove that the Agent resumed productive work.

Ordinary Agent task execution does not require starting or upgrading a Worker.
Use the scoped executable wrapper and development root for that Agent instead.
An old Worker remains old after installation. Its managed startup prompt also
retains the behavior of its running package: a version that used a bundled
managed skill continues to do so. Current Workers provide assignment and runtime
constraints in the prompt assembled by their package; `daynight --skill` provides
product operations, and repository rules govern delivery. Existing Controller
processes and Agent aliases can retain their original snapshot; use a new
execution to verify the new chain, without deleting or silently retargeting old
sessions.

## Installed skill

Prepare the executable router and shell activation using
[test repository preparation](test-repository.md). Keep npm's original entries
and managed Agent alias precedence intact.

`dev:install` does not refresh installed `using-daynight` copies. To exercise the
new bundled skill in an ordinary Agent, inspect existing customizations, then
run the interactive installer from the playground when that replacement is in
scope:

```bash
cd "$DN_PLAYGROUND"
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" skill install
```

Choose the intended Agent and Project scope, then follow reload instructions.
The installer replaces the complete leaf; avoid unintentionally replacing User
scope or customized content. Installed skills and project `.daynight` are not
isolated by `DN_CONFIG_DIR`. Keep the skill's canonical command spelling and use
the runtime alias rather than editing installed copies.
