# Isolated development and CI deployment

This deployment runs the authenticated dashboard, API, PostgreSQL and a real
UniAuth fixture in a disposable Docker Compose project. It uses the
[localhost Dockerfile](../localhost/Dockerfile) and
[TCP gateway configuration](../localhost/nginx.conf), with the same frontend
build, embedded Go assets, strict loopback server listener and nonroot runtime
as the normal deployment. Trusted same-origin executable HTML previews retain
their existing iframe, relative-resource and keyboard behavior.

For an npm mirror, export `DAYNIGHT_NPM_REGISTRY` before invoking the runner;
its build argument and default are shared with the
[localhost deployment](../localhost/README.md#configure-and-start).
`DAYNIGHT_TASK_SYNC_OVERLAP` is also passed to the server, defaulting to `10s`.
Set it to a positive Go duration such as `250ms`, `30s` or `1m30s` when exercising
a different task-sync lookback window. Invalid, zero and negative values fail
server startup. The window is server configuration; clients cannot override it.

The runner requires Bash, standard shell utilities, Node.js 24, Docker Engine 28
or newer, Linux containers and Docker Compose 2.20 or newer. Linux Docker engines
on `amd64` and `arm64`, including Docker Desktop Linux containers on macOS, are
supported. By default, Git and host Go 1.27.2 prepare a fixture from the pinned
UniAuth revision
[`0978963813fcefd9d553f6cb9bcc319084c764b3`](https://github.com/codetreker/uniauth/tree/0978963813fcefd9d553f6cb9bcc319084c764b3).
The runner queries the Docker daemon architecture and prepares an explicit
`linux/amd64` or `linux/arm64` executable, then checks it against the built
production image architecture. Target binaries have separate cache entries from
host-native fixtures. Preparation and Go caches stay under the server module's
`.tmp/`; the first preparation requires network access to GitHub and Go module
sources. Host PostgreSQL, jq and workspace package installation are not required.

To supply a prepared fixture, set `DAYNIGHT_UNIAUTH_FIXTURE_BINARY` to an absolute
executable path. This removes the fixture build's Git and Go requirement, while
Node.js remains required for the runner. The override must be a Linux ELF
executable matching the production image's `amd64` or `arm64` architecture; a
macOS host executable is rejected.

## Run a command against the stack

From the repository root:

```bash
bash deployment/dev-ci/run.sh bash -c \
  'curl --fail-with-body "$DAYNIGHT_BASE_URL/readyz"'
```

The runner can be invoked by path from any directory. It prepares the fixture,
builds a unique image, then starts PostgreSQL and the gateway before discovering
the random main-site port published on `127.0.0.1`. It registers that exact origin
and callback in the real UniAuth fixture, which runs as a sidecar in the gateway's
network namespace. A second loopback-published port maps to the same port inside
that namespace, so both the browser and the Go server reach one fixture URL.
The runner records the fixture's generated application credentials in a private
environment file, starts the authenticated server and waits for `/readyz`.

`/healthz` and `/readyz` are public database probes and do not call UniAuth. The
server and gateway Compose health checks use `/readyz`. Business endpoints still
require a browser session or personal access token; the public readiness example
does not perform a login. Acceptance clients use the shared
[authentication fixture helper](../../packages/daynight-server/scripts/auth-fixture.mts)
and the private fixture descriptor to complete real login handoffs.

The runner checks that the running server uses the exact image ID produced by
this run, then calls the command with its arguments unchanged. The command
inherits:

| Variable | Value |
|---|---|
| `DAYNIGHT_BASE_URL` | Main-site HTTP origin, such as `http://127.0.0.1:32777` |
| `DAYNIGHT_DEV_CI_RUN_ID` | Unique run identity used in receipts and cleanup |
| `DAYNIGHT_DEV_CI_AUTH_ENV_FILE` | Absolute private environment-file path for this run's Compose commands |
| `DAYNIGHT_AUTH_FIXTURE_DESCRIPTOR` | Absolute private fixture descriptor path used by authentication clients |

The runner does not evaluate the command as shell text. Explicit `bash -c` is
needed when a command needs shell expansion, as in the example. The callback
keeps its caller's working directory. Fixture preparation and the production
image build each have a separate 600 second bound. Startup stages have bounded
Docker operations; server activation has a 150 second outer bound around
Compose's 120 second readiness wait. The callback's duration is controlled by its
caller.

Each invocation uses `daynight-dev-ci-<run-id>` as the explicit Compose project
and a unique `daynight-dev-ci:<run-id>` image tag. All Compose operations use the
same absolute file and project directory with the run's private environment
file, regardless of inherited `COMPOSE_FILE` or `COMPOSE_PROJECT_NAME`. Services,
networks and the `postgres-data` and `attachment-data` named volumes have
project-scoped names. PostgreSQL has no host port, and no resource uses a fixed
container name or an external volume/network. Multiple invocations can run
concurrently. The server receives
`DAYNIGHT_STORAGE_ROOT=/var/lib/daynight/storage`, mounted from this project's
attachment volume. Fresh-volume initialization preserves the image directory's
UID/GID `10001:10001`; the normal nonroot process writes the files. No test uses
the localhost deployment's persistent volumes.

The runner explicitly enables `DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN=1` for the
main-site HTTP origin and its Cookie policy, and
`DAYNIGHT_ALLOW_LOOPBACK_HTTP=1` for the SDK's literal-loopback HTTP UniAuth URL.
These independent test settings keep login and project authorization active.
UniAuth configuration and fixture state are private files under
`.tmp/dev-ci-private/<run-id>/`, including the fixture SQLite database. They are
separate from uploadable receipts and from the two application data volumes.

## Recreate and restore a running test stack

A callback that removes or recreates the gateway can receive a new published
main-site port. Reconfigure the fixture registration and server together:

```bash
bash deployment/dev-ci/run.sh --reconfigure RUN_ID
```

Use the active run's `DAYNIGHT_DEV_CI_RUN_ID` as `RUN_ID`. The command requires
that run's receipt and private authentication state. It starts PostgreSQL and the
gateway, discovers the new origin, stops the old server and fixture, recreates
the fixture with the updated callback, rewrites the private environment, and
starts the server with readiness checks. Read the resulting main-site origin
from `.tmp/dev-ci/<run-id>/base-url` and log in again after reconfiguration.

For a paired SQL/file restore, prepare the dependencies and fixture while
leaving the server stopped:

```bash
bash deployment/dev-ci/run.sh --reconfigure RUN_ID --bootstrap
```

Keep all server instances and direct database or file writers stopped. Restore
SQL and the attachment archive into their fresh application volumes, then use the
project's PostgreSQL service to run
`UPDATE projects SET task_cache_epoch = gen_random_uuid()` for the affected
projects before running `--reconfigure RUN_ID` to start the server. Restrict the
`UPDATE` to the fixture's project IDs when restoring selected fixture data. Saved
UUIDs are part of the SQL backup, so restoring them does not identify the replaced
history. Normal writes, restarts and recreation preserve the project's epoch.
Keep database time valid and check imported task timestamps separately; epoch
rotation cannot repair future-dated task data. The private UniAuth fixture
directory survives application volume recreation; there is no third backup
volume. The
[attachment persistence check](#attachment-persistence-check) exercises this
ordering. Reconfiguration belongs to the active runner's lifecycle and leaves
its resources for the original runner to clean up.

## Completion, failure and cancellation

Cleanup is registered before Docker operations. Normal exit, callback failure,
partial startup and `INT`/`TERM` all collect project diagnostics, run targeted
`down --volumes --remove-orphans`, confirm that the project's containers,
volumes and networks are absent, and remove only this run's image tag. Callback
process groups receive termination on cancellation. Docker commands and cleanup
operations have independent bounds; a callback's failure status is retained if
cleanup also fails. Cleanup failure makes a successful callback fail. The
callback's process group remains owned after its leader exits, so cleanup also
terminates background descendants after successful or failing callbacks.

Successful cleanup removes the private authentication directory and generated
application secrets. If resource cleanup fails, the runner removes credentials
from its private configuration and retains fixture state and redacted metadata
needed for a later targeted recovery. A process killed before cleanup can leave
private files behind; treat them as credentials until recovery completes.

The runner never operates `daynight-localhost`, the normal fixed-name
containers, another dev-ci project, or shared build caches. It does not run
Docker prune or remove unnamed resources by global enumeration.

## Receipts and CI recovery

Receipts remain in `.tmp/dev-ci/<run-id>/` at the repository root:

| File | Content |
|---|---|
| `manifest.json` | Versioned run identity, project, image tag/ID, observed container/volume/network identities, origin, final phase, command result and cleanup result |
| `compose-ps.txt` | Project-scoped service diagnostics |
| `compose-logs.txt` | Project-scoped service logs |
| `bootstrap.log` | Dependency-start diagnostics, including bounded fixture-port allocation failures |
| `image-id`, `base-url`, `container-ids`, `volume-names`, `network-ids` | Validated scalar/list state used by recovery without sourcing shell code |
| `recovery-manifest.json` | Result of an explicit recovery cleanup, preserving the original manifest |

The manifest is atomically replaced at each phase. `result` is `running`,
`passed`, `failed` or `cancelled` for a normal invocation; recovery records
`recovered`. `cleanupResult` is `pending`, `passed` or `failed`. The manifest
stores neither callback arguments nor environment dumps or request bodies.
Service diagnostics follow the server's sanitized logging policy. Upload
`.tmp/dev-ci/<run-id>/` receipts as CI artifacts, keeping
`.tmp/dev-ci-private/<run-id>/` outside artifact paths.

A CI `always()` cleanup step can handle a runner killed before its trap finishes:

```bash
bash deployment/dev-ci/run.sh --cleanup RUN_ID
```

Stop the original runner and its callback process group before recovery, so it
cannot create resources after cleanup. `RUN_ID` must match the generated numeric
identity format and have an existing local receipt. The runner derives the
project and image tag from that identity, uses the same bounded, targeted
cleanup, removes retained private state after resource cleanup succeeds and
writes `recovery-manifest.json`. Empty, malformed, unknown and normal localhost
identities are rejected before Docker operations. An interrupted run can leave
a unique image tag or project resources until recovery succeeds; retain the
receipts as CI artifacts when reporting a failure.

## Runner checks

The Bash fixture tests exercise success, malformed cleanup identities, build and
partial-startup failures, image mismatch, callback failure, cleanup failure,
recovery, cancellation and callback descendants without starting Docker. The
fixture records both data volumes and rejects cleanup that leaves only the
attachment volume behind:

```bash
bash deployment/dev-ci/tests/run.sh
```

Production-image HTTP/browser acceptance uses this runner with a real Docker
daemon and UniAuth fixture. Fake-Docker checks verify orchestration and cleanup
decisions; they do not establish authentication or browser behavior. The
[authentication architecture](../../docs/design/daynight-auth.md) owns the
cross-layer validation requirements.

## Attachment persistence check

With the runner's prerequisites, run from the repository root; no host workspace
dependencies are required:

```bash
node deployment/dev-ci/tests/attachments.mts
```

The check starts two independent invocations of the existing runner and uses the
production Dockerfile, embedded Web build, gateway and real UniAuth fixture. Each
client logs in before creating its project and task. It verifies fresh-volume
ownership and UID 10001 writes, nested text/binary and HTML/CSS uploads, exact
metadata and byte hashes through download and inline preview routes, server
stop/start and full stack recreation. Authenticated task-sync reads capture the
project's epoch and prove it survives both normal operations. The check
reconfigures the fixture and logs in again after recreation changes the gateway
port. The two projects have separate database and attachment volumes; each
rejects the other's project/task paths.
Cleaning one deployment leaves the other's existing files and new uploads usable.

For paired restore, the check stops the server, captures `pg_dump` and a `tar`
archive of its attachment root, removes only that project's stack and application
volumes, and uses `--reconfigure --bootstrap` before restoring SQL and files into
fresh volumes. With the server still stopped, it rotates only the restored
fixture project's `task_cache_epoch` through that project's PostgreSQL service,
then activates the server with `--reconfigure` and logs in again. It confirms the
epoch changed and a request using the old epoch and a future `since` returns the
full snapshot. The fixture's private directory remains outside those volumes.
The archive uses a one-off container from the same production image with a `tar`
entrypoint and the ordinary service user. Reads, previews and another nonroot
upload must succeed after restoration. The
[localhost backup procedure](../localhost/README.md#persistence-and-backup)
owns the operator commands and the accepted pre-existing consistency limitation.

Source-bound receipts are written under `.tmp/attachment-deployment-*/` and the
two normal `.tmp/dev-ci/<run-id>/` directories. They record owned project and
volume identities, performed phases, task-sync epoch observations, metadata and
SHA-256 values. SQL dumps and file archives are removed after the check; they are
test data, not retained backups. The runner performs scoped cleanup on success
or failure, and the check
requires both final cleanup receipts and absence of project resources and image
tags. Keep receipts with the corresponding PR or CI run when reporting results.
