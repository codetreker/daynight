# Capture One Consistent UI State

Use `scripts/capture-ui-evidence.mjs` after preparing an owned, isolated browser
context with the [local identity procedure](local-identity.md). It accepts an
existing Playwright-compatible `Page`; it does not launch a browser, connect to
the user's profile, click controls, send messages or write application data.
Use [website guidance](website.md) for interaction and server readback, and
[the audit guide](ui-audit.md) to turn observations into individual findings.

## Select meaningful readiness

Require the intended fixture's identity and the state being assessed. For an
assistant, select its name and the exact `Ready` or `Started` label actually
present in the current locale. For an empty or failed state, select that state's
own identifying text. A failure screen can be valid evidence when it is the
intended observation.

Readiness uses exact text after whitespace normalization on a visible matching
element. An HTTP 200, `body`, a fixed delay or disappearance of the login spinner
does not establish that an assistant has finished loading. Choose specific CSS
selectors from the observed DOM. Do not include a live clock, elapsed timer or
other continuously changing text among the readiness conditions or text
observations unless its change is the issue under examination.

Capture geometry and the visual artifact in the same call. A measurement taken
during `Loading…` cannot be paired with a later PDF showing `Ready`. Once ready,
the helper samples the selected state, captures the requested artifact, then
samples again. Changes to readiness, selected geometry/text, viewport, route or
document state mark the result `inconsistent`.

## Call the helper

The caller verifies the UI source/build identity independently, creates the
parent output directory under the task worktree's ignored `.tmp/`, and owns the
page's lifecycle. Do not reuse a previous capture directory.

```js
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { captureUiEvidence } = await import(pathToFileURL(path.join(
  taskWorktree,
  '.agents/skills/prepare-daynight-local/scripts/capture-ui-evidence.mjs',
)));

const result = await captureUiEvidence(page, {
  expectedOrigin: 'http://127.0.0.1:5173',
  source: { commit: verifiedUiCommit, dirty: false },
  outputDir: path.join(taskWorktree, '.tmp', 'ui-audit', 'bot-ready-390-01'),
  ready: [
    { selector: '[data-testid="bot-name"]', text: 'Layout fixture' },
    { selector: '[data-testid="bot-state"]', text: 'Ready' },
  ],
  observe: [
    { name: 'title', selector: 'h1' },
    { name: 'actions', selector: '[data-testid="bot-actions"]' },
  ],
  mode: 'screenshot',
  timeoutMs: 10_000,
});

if (result.status !== 'consistent') {
  // Inspect evidence.json; this sample cannot support a stable layout conclusion.
}
```

Selectors above illustrate the API; they are not promises about current
Daynight markup. Inspect the actual page before choosing them. `commit` is a
full 40-character Git SHA and `dirty` must be explicit. The optional `source.build`
records a short verified artifact identifier. A supplied SHA is attribution, not
proof that the running page came from that source; retain the environment's
build verification, including changes when testing a dirty checkout.

`observe` is an explicit allowlist and can be empty. Each entry has a unique
`name` and specific `selector`; set `includeText: true` only when the selected
text is necessary and contains no sensitive data. Selectors may match at most
24 elements. Measurements include rectangles, client/scroll dimensions,
visibility and relevant text/overflow styles. A missing observation is recorded
with count zero; add a readiness condition if that element must exist first.

## Choose the evidence type explicitly

| Mode | Artifact | What it establishes |
| --- | --- | --- |
| `screenshot` | `screen.png` | The captured viewport's compositor output, paired with selected DOM state |
| `screen-pdf` | `screen.pdf` | Static screen-media print rendering, with viewport-equivalent page dimensions and zero margins |
| `geometry` | None | Selected DOM geometry/state only; no visual rendering claim |

There is no automatic fallback. When screenshots fail, retain that failure and
use [browser-platform diagnostics](website.md#distinguish-browser-platform-failures-from-product-failures).
If PDF evidence is appropriate, make another explicitly identified capture in a
new directory:

```js
// Prepare screen media on the caller's disposable page before requesting PDF.
await page.emulateMedia({ media: 'screen' });
const result = await captureUiEvidence(page, {
  ...captureOptions,
  outputDir: newPdfCaptureDirectory,
  mode: 'screen-pdf',
  screenMediaConfirmed: true,
});
```

The helper leaves media settings untouched. `screenMediaConfirmed` attests that
the caller explicitly selected screen media; `matchMedia('screen')` alone is not
enough because it can be true before PDF switches to print media. Restore a known
prior media setting yourself or close the owned context after use. The PDF can
paginate content beyond the first viewport. PDF-to-PNG conversion remains PDF
evidence and must not be labeled a screenshot. Neither PDF nor viewport emulation
proves animation, compositor stability or a real mobile soft keyboard's behavior.

## Read and retain the result honestly

The returned object contains `status`, `directory`, `manifestPath`, and
`artifactPath` when an artifact was retained. A new directory uses mode `0700`;
files use `0600`. Existing files, directories and symlinks are never overwritten.
The parent directory must already exist. Invalid options and output filesystem
errors reject the call.

`evidence.json` has `format: "daynight-ui-evidence-v1"`, the source identity,
expected origin, requested mode, timestamps, `before`/`after` observations and:

- `consistent`: the selected state was ready and equal before and after capture.
- `inconsistent`: an artifact may exist, but selected state or navigation changed;
  `changes` names the differing fields. Do not use it as a stable paired sample.
- `failed`: readiness, sampling or capture failed; there is no accepted visual
  artifact. `failure` records the stage, code and error class. Readiness timeouts
  retain `lastReadiness`; they never pretend that `before` was ready.

`artifact` is `null` or an object with relative `path`, `kind` (`screenshot` or
`screen-media-pdf`) and `compositorScreenshot`. Browser error messages are not
serialized because they can contain request URLs or page content. A `TIMEOUT`
is evidence of the unsuccessful operation, not evidence of a product defect.
The browser-operation budget defaults to 10 seconds and is capped at 60 seconds.
After an operation times out, close the owned context before further tests:
the timeout bounds the helper's wait but cannot cancel an arbitrary Page call.

Only an exact localhost/loopback origin is accepted; a different port or hostname
is a different origin. Main-frame navigation to another origin fails the sample
and discards captured bytes even if the page returns. Raw query strings and
fragments are omitted; a route fingerprint detects their changes. The DOM sampler
does not read cookies, storage, environment variables or form values, and text
collection omits editable controls and script/style content. Visual artifacts
still show painted page content, including displayed form text: use synthetic
fixtures without credentials and review artifacts before sharing them.

`consistent` means the chosen observations agree at both boundaries. It is not a
UI pass, proof of application correctness, or a guarantee that no transient
change occurred between samples. Add focused observations, interaction results
and server readback according to the finding. Keep an untested state untested
instead of inferring it from an adjacent state's evidence.
