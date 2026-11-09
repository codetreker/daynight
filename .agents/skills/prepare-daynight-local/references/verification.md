# Verification and Recovery

Use the absolute paths resolved in [the refresh procedure](refresh.md). Attach a
result to its source, origin and execution context; an installed launcher is not
evidence about the package of an already-running process.

## Verification layers

| Layer | Evidence required |
| --- | --- |
| Artifacts | Selected source SHA and dirty state, build result, server binary hash/image identity, development build metadata and packaged UI/SQL resources as applicable |
| Running site | Actual process/container uses the selected artifact and runtime configuration; public page/API routing works, bounded backend health probes return the expected JSON, and the actual Web Session connection progresses through the selected public origin |
| Local account/project | Correct-origin login if needed, authenticated CLI read of the intended local project; browser login is separately observed |
| Terminal | Real test-repository shell routes to the development build/root; outside the directory the router delegates to the ordinary command from current PATH without changing the parent's root |
| Agent | A new actual Agent verifies command resolution, build metadata and selected development root in the chosen ordinary or Worker/Controller launch context; its native Provider environment is available and the model turn actually runs |
| Local test loop | Required for complete test-environment preparation: CLI and website round trips plus the expected managed Agent's claim-bound completion, as defined in the local test loop reference |

For each layer, state verified, failed or not exercised, with the observation.
Use [the website guide](website.md) to gather browser evidence separately from
CLI output and source inspection.
`/readyz` checks database readiness, not UniAuth or Agent dispatch. `--build-info`
prints snapshot metadata without proving login, actual Worker identity or the
effective state root. A browser display and a CLI response need not come from the
same environment.

For Vite, include [WebSocket Upgrade routing](refresh.md#websocket-routing-through-vite)
in the Web-mode check. A healthy HTTP route cannot prove the Controller connection
works. For Worker recovery, report original claim/execution/Session/native IDs
separately from a replacement Controller generation; follow
[native environment and retained execution checks](refresh.md#native-provider-environment-and-retained-executions).
Starting a process is not evidence that a failed turn was retried.

For UI audits, record the viewport, locale, input method and tested state under
[the audit procedure](ui-audit.md). DOM geometry, screen-media PDF, compositor
capture and real mobile-keyboard checks are different evidence. A documented
capture-platform failure does not invalidate successful pointer/CLI readback,
but it leaves the missing visual or animation checks unverified.

For an embedded or Compose site, health probes use the verified public origin.
For Vite, probe `/` and API routing through the browser origin, but send health
probes directly to the verified Go backend origin. An unproxied `/readyz` can
return Vite's HTML fallback with status 200; status alone proves no readiness.
Set `DN_HEALTH_ORIGIN` accordingly and require the expected JSON (`status: ok`
for `/healthz`, `status: ready` for `/readyz`). For example:

```bash
set -o pipefail
curl --fail --silent --show-error --max-time 10 "$DN_HEALTH_ORIGIN/readyz" |
  node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => { if (JSON.parse(s).status !== "ready") process.exitCode = 1; });'
```

Use the CLI for authenticated project/task reads through the configured public
origin, with the explicit development root and a known local project:

```bash
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" project list --json
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" project show "$DN_PROJECT_ID" --json
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" task list --project "$DN_PROJECT_ID" --json
```

Set `DN_PROJECT_ID` from the intended local project, not a production bookmark.
Do not automatically register missing projects during inspection. Task commands
without `--project` may persist an automatically discovered project binding in
the repository, so they are not a substitute for these read-only checks.

In the actual playground shell and later the actual new Agent, check:

```bash
command -v daynight
daynight --build-info
daynight --version
printenv DN_CONFIG_DIR
```

If `dn` is configured, check its resolution and version too. Interpret the root
in that context: a wrapper may set it only inside the child, while an Agent shim
expects the launch environment to carry it. Inspect wrapper/root selection and
confirm the mapped command reads the intended local project; a parent's unset
variable alone does not prove its wrapped child uses stable state. Preserve a
user-specified exact probe sequence instead of adding unrelated commands.

Environment preparation records stay local; do not use Daynight tasks to track
this work. For a requested complete test, the only task writes are the bounded
localhost fixture and its evidence under [the local test loop](local-test-loop.md).
Ordinary Agent routing checks need no Worker or claim and cannot substitute for
that managed loop. Shell simulation validates mechanics, not a complete task run.

## Failed cutover and retention

Preserve the old and new artifact identities and the first meaningful error.
After a failed start, inspect the exact process/container and logs before another
start; a timeout does not prove nothing started. Avoid restarting healthy shared
database/authentication services as a generic retry.

Server startup can migrate PostgreSQL, and new CLI/Worker/Controller operations
can migrate SQLite state. An old binary, image or CLI symlink may no longer read
the updated state. Resume with the compatible build or follow the existing
[paired database/storage recovery](../../../../deployment/localhost/README.md#persistence-and-backup)
under its own scope. Do not provide automatic database downgrade or treat an old
symlink as a complete rollback. Backups of live SQLite need a consistent method
that includes its WAL state or stopped writers; a lone database-file copy is
not sufficient evidence of recoverability.

Keep a retained-resource list: build worktree, live server artifact/image, current
and still-used CLI snapshots, their fixed Node executables, Agent shim directories,
development state root, database/storage, private configuration and service logs.
Installation provides no automatic garbage collection. Remove only explicitly
obsolete, task-owned resources after verifying no process, descendant or retained
execution can require them. Do not recursively remove `.tmp`, shared module
caches, worktrees or development state as routine update cleanup. If ownership is
uncertain, retain and report the resource.
