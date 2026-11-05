# Local Test Identity and Background Browser Setup

Use the maintained authentication fixture for normal localhost preparation and
CLI/website acceptance. It replaces the external GitHub response with a selected
test persona while exercising real UniAuth authorization, PKCE and callback
handling, Daynight browser sessions and PAT creation. Product authentication and
project permissions remain enabled. This is a test harness, not a product
`disable-auth` setting or automatic login for ordinary browser profiles.

Real GitHub OAuth and device authorization are separate checks when explicitly
requested. The default loop needs neither interactive step.

## Prepare the maintained fixture

Use the selected source's
[preparation script](../../../../packages/daynight-server/scripts/prepare-uniauth-fixture.mts)
and canonical
[authentication helper](../../../../packages/daynight-server/scripts/auth-fixture.mts).
From the server module, prepare or verify the pinned fixture binary:

```bash
cd "$DN_SOURCE/packages/daynight-server"
node scripts/prepare-uniauth-fixture.mts
```

The command returns the binary's absolute path on stdout. It may fetch the pinned
UniAuth source and build dependencies; use the selected revision's toolchain and
keep its existing cache. Do not substitute a hand-written auth server or maintain
a copied implementation of the helper.

In a task-owned launcher under the retained worktree's `.tmp/local-development/`,
import `startAuthFixture` from the canonical module and call it with:

- `binary`: the verified preparation output.
- `directory`: a private, owned fixture directory outside the test repository.
- `callbackURL`: the exact callback registered for this local site's public origin.

The helper starts a loopback listener, verifies and consumes its `0600` readiness
file, and returns `origin`, `appId`, `appSecret`, `child` and `close()`. Retain that
owner for the environment's lifetime; call `close()` when its owned fixture is
being stopped. Do not detach a process with no retained identity or cleanup path.

Pass the returned values to the Daynight server through private configuration:

| Setting | Value |
| --- | --- |
| `DAYNIGHT_UNIAUTH_URL` | Returned fixture `origin` |
| `DAYNIGHT_UNIAUTH_APP_ID` | Returned `appId` |
| `DAYNIGHT_UNIAUTH_APP_SECRET` | Returned `appSecret` |
| `DAYNIGHT_UNIAUTH_CALLBACK_URL` | The same `callbackURL` used to start the fixture |
| `DAYNIGHT_PUBLIC_ORIGIN` | Exact loopback public origin used by the browser and CLI |
| `DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN` | `1` for the HTTP localhost site |
| `DAYNIGHT_ALLOW_LOOPBACK_HTTP` | `1` for the HTTP loopback fixture |

Keep App secrets, PATs, cookies and database URLs out of logs, command arguments
and committed files. If a private settings file is needed, use a `0700` directory
and `0600` file and read it inside the launcher. Record only its path and the
nonsecret resource identity.

Use the registered callback path consistently. `/api/v1/auth/callback` is valid;
an existing environment can use another allowed path such as `/api/auth/callback`.
For Vite, verify that this exact route and `/api` reach the intended Go backend.
The callback must use the public origin, not a different backend health origin.
A Compose server needs a fixture address reachable from its own network namespace;
host loopback and container loopback are not interchangeable.

Before changing an existing gateway, inspect active local executions and the
environment's ownership. Preserve any shared real gateway and unrelated accounts.
A different fixture registration or persona can yield a different Daynight user;
switching authentication does not transfer prior projects, task assignments or
Worker enrollment. Reuse the intended test identity when available, or use the
separately recorded disposable environment described in
[state isolation](test-repository.md#isolate-state-and-identify-the-local-service).

## Authenticate the CLI and browser

Use the selected source's
[Web authentication adapter](../../../../packages/daynight-web/tests/e2e/authentication.ts),
which delegates to the canonical helper. With the verified `DN_LOCAL_ORIGIN` and
one persona such as `alice`:

1. `createApiToken(origin, persona)` creates a real local PAT. Merge it as
   `serverToken` into `$DN_DEV_ROOT/config.yml` with the matching `serverUrl`, using
   a YAML parser and preserving the development Worker settings. Write privately
   without printing the token. Never copy a stable token or pass it on a CLI command
   line. The convenience helper creates a one-day credential; for a retained test
   environment, check expiry when resuming and renew only the intended test account.
2. `browserAuthentication(context, origin, persona)` uses the same Playwright
   context's request/cookie store to establish its browser session. Navigate with
   that context afterwards; a newly created context does not inherit the login.
3. Compare the actual `/api/v1/me` user ID in both clients and verify the expected
   project membership before creating or dispatching fixtures. Matching persona
   labels alone are not identity evidence. For the configured CLI credential,
   use `tokenContext(request, origin, config.serverToken)` from that same adapter
   to read `/api/v1/me`, then verify an actual CLI project read. Compare it with
   the browser's authenticated identity; do not print authorization headers or
   response cookies. Dispose the temporary API context after the check.

These helpers issue normal product session/PAT requests. They do not need
interactive `daynight-dev login`, device approval, SQL identity insertion,
invented cookies or mocked `/api/v1/me`. Identity preparation does not count as
the website leg: task readback, automatic-execution enablement and result reads
still use the real UI under [the website guide](website.md).

## Use Edge without a visible window

Use the repository's installed Playwright package and an isolated headless browser.
Use Edge by default unless the user selects another browser. Request its `msedge`
channel or an explicitly verified Edge executable path. Do not attach to the
user's ordinary Edge profile, export its
cookies, change its active tab or silently substitute Chrome. Missing Edge is a
tool-availability gap; inspect the installation before choosing another browser.

The following core belongs in an owned `.mts` probe under
`$DN_SOURCE/.tmp/local-development/`. Resolve imports from the selected checkout;
Node.js 24 can load the maintained TypeScript helpers directly:

```typescript
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const source = process.env.DN_SOURCE!;
const origin = process.env.DN_LOCAL_ORIGIN!;
const url = new URL(origin);
assert.equal(url.origin, origin);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
const require = createRequire(`${source}/packages/daynight-web/package.json`);
const { chromium } = require('@playwright/test');
const { browserAuthentication } = await import(pathToFileURL(
  `${source}/packages/daynight-web/tests/e2e/authentication.ts`,
).href);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext();
  context.setDefaultTimeout(15_000);
  await browserAuthentication(context, origin, 'alice');
  const page = await context.newPage();
  await page.goto(`${origin}/projects`);
  await page.locator('main#main-content').waitFor();
  const state = await page.evaluate(() => ({
    visibility: document.visibilityState,
    focused: document.hasFocus(),
  }));
  assert.equal(state.visibility, 'visible');
  assert.equal(state.focused, true);
  // Inspect current accessible controls and perform the requested UI checks here.
} finally {
  await browser.close();
}
```

Validate the actual authenticated page and requested result, not only its
shell being present. Use bounded waits on expected controls or responses and retain
credential-free screenshots/results. Headless does not mean the page's focus
state can be assumed: inspect it and diagnose missing requests without rewriting
visibility/focus properties or fabricating product responses. A failed assertion
leaves the UI leg incomplete. Close only the browser instance owned by the probe;
keep long-lived site, fixture and Worker resources according to the requested
environment lifetime.

If animation-frame waits or screenshots fail even on a blank page, use the
[browser-platform diagnostic and evidence limits](website.md#distinguish-browser-platform-failures-from-product-failures).
Do not treat a harness failure as proof of a product defect or move testing into
the user's ordinary window to bypass it.

## Optional real OAuth and device authorization

Choose this mode when the user specifically wants real login/consent coverage or
manual interaction with their own local account. Keep the actual UniAuth gateway,
App registration and local callback consistent, and preserve unrelated accounts
and tabs. Real sign-in and credential-grant decisions remain with the user.

For CLI device-flow acceptance, run the selected development command with its
explicit root:

```bash
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" login
```

Use the local `/device?user_code=<URL-encoded CLI user code>` page. The `user_code`
query preloads inspection, not approval. The user compares the code, selects the
matching-code checkbox and clicks Authorize CLI (`授权 CLI`). Do not record real
codes in durable documentation. Follow the website guide's background-request
diagnostics when the ordinary tab is inactive. This optional layer must not
block the default test-identity loop or be reported as verified by it.
