# Temporary webhook test host

This fixture runs the production webhook, identity, Team, Task, Step, Thread and Project routes
with real authentication and PostgreSQL. It binds only to loopback and creates
an isolated schema. Destinations and signing secrets use the production plaintext
storage format. The controlled receiver records HMAC headers for independent
verification. It does not start the delivery runner until requested.

From `packages/daynight-server`, set `DAYNIGHT_TEST_DATABASE_URL` to a disposable
PostgreSQL database and set `DAYNIGHT_WEBHOOK_FIXTURE_TOKEN` to a valid `dnst_`
session token chosen by the caller. Set `DAYNIGHT_WEBHOOK_FIXTURE_PAT` to a
valid `dnpat_` personal access token chosen by the caller. Provide distinct
`DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN` and `DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT`
for a second user. For example, generate each value privately with `node -e "process.stdout.write('dnst_'+require('crypto').randomBytes(32).toString('base64url'))"`, replacing `dnst_` with `dnpat_` for the PAT.
Start the host with:

```sh
go run -tags webhookfixture ./testdata/webhook-host
```

The first stdout line is a JSON object containing `url`, `origin`, `userId`,
`memberId`, `teamId`, `projectId`, `receiverUrl`, and `schema`. It never contains
the credentials. The first user is a Team admin; the second is a Team member.
Send the session token as the `daynight_session` cookie; cookie mutations must
include the reported `origin` in the `Origin` header. Alternatively, send the
PAT as `Authorization: Bearer <PAT>`. Each user also has a personal Team;
the reported Project belongs to the shared Team. The host does not grant CORS
access to other origins. Configure a webhook through the production API using
`receiverUrl`, then create source events through the production Task routes.

Fixture controls require the admin identity; cookie requests also require the
reported origin:

- `POST /__fixture/runner/start` starts the real runner once.
- `POST /__fixture/runner/stop` stops it; the same runner cannot be restarted.
- `PUT /__fixture/receiver/status` accepts JSON `{"status":503}` with an HTTP
  status from 200 to 599; the default is 202.
- `GET /__fixture/receiver` returns captured request bodies as Base64, event
  IDs, timestamps, signatures and the response status selected for each call.
- `POST /__fixture/shutdown` stops the host and removes its schema.

The receiver uses a temporary TLS certificate; the fixture-only build tag
permits a scoped loopback transport with that certificate as its trust root.
Normal product builds keep their existing transport policy. For cleanup, call
`/__fixture/shutdown` and wait for the process to exit. If using signals with
`go run`, signal its entire process group so the compiled child also receives
SIGTERM. Shutdown closes the HTTP listener and waits for active handlers before
stopping the runner and releasing the database. If the graceful wait times out,
it closes active connections and uses a separate cleanup budget to wait for
handlers and stop the runner before removing the schema. The controlled TLS
receiver also has a bounded graceful shutdown followed by forced connection
closure and a wait for its handlers. A handler that does not terminate after its
connection is closed can still prevent safe cleanup. Startup
failures and normal shutdown remove the fixture schema. No persistent service is installed.

Run the executable and lifecycle checks with:

```sh
go test -tags webhookfixture ./testdata/webhook-host
```
