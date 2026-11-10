# Agent Note: Product E2E Browser Installation

Status: implemented

## Problem

Product E2E can fail before downloading Chromium or executing a product assertion.
The Linux browser preparation step combines Playwright's browser download with
a host APT transaction under one four-minute deadline.

Main [run 42753123509](https://github.com/codetreker/daynight/actions/runs/42753123509/job/129621250187)
and [run 42734262453](https://github.com/codetreker/daynight/actions/runs/42734262453/job/129559650560)
both reach that deadline while downloading Ubuntu resolute packages from
`azure.archive.ubuntu.com`. All Chromium runtime shared libraries are already
installed. The remaining nine font and X font packages require 21.9 MB; downloads
continue slowly until cancellation. Neither run reaches the product journey.

## Decision

The Product E2E job uses the package's locked
`playwright install chromium` command, with the original four-minute deadline
and checkout-local browser path. The GitHub-hosted Ubuntu image supplies runtime
shared libraries; Playwright supplies the exact Chromium and headless shell
selected by the lockfile. The [package guide](../../../../packages/e2e_tests/README.md#ci)
owns the setup instructions.

Playwright's [`withDeps` branch](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/playwright-core/src/cli/installActions.ts)
controls the separate host-package installation. Its
[dependency installer](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/playwright-core/src/server/registry/index.ts#L920)
adds a tools group containing fonts and X packages to the browser dependencies.
Those additional font packages have no dedicated glyph, font-family or screenshot
comparison assertions in this product journey.

Default host dependency validation remains enabled. The installer reports host
validation errors as warnings, so download success alone does not establish a
usable browser. The existing
[browser launch](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/playwright-core/src/server/browserType.ts#L186)
awaits that validation and propagates errors. The complete unchanged product
journey must launch the locked browser, exercise its assertions and verify
resource cleanup. Missing libraries and download failures remain failures.

## Alternatives

**Increase the combined installation timeout.** Both failures spend their budget
on additional font downloads while runtime libraries are already present. A larger
allowance preserves that recurring network dependency and consumes the job's
reserved cleanup and upload time.

**Change the runner image or APT mirror.** This changes the surrounding host or
package-source configuration without removing the unnecessary package transaction.
The observed host already provides Chromium's runtime libraries; this repair
keeps the existing image and toolchain.

**Use a system browser or skip host validation.** Either changes the browser
under test or hides a missing runtime requirement. The lockfile browser and
actual launch validation remain part of the proof.

## Consequences

Routine Product E2E preparation downloads the locked browser without starting
APT. All product assertions, execution deadlines, cleanup and required checks
remain unchanged. A future runner image missing a required shared library will
fail during real browser launch and require an explicit setup decision.

This setup does not promise installation on arbitrary Linux hosts or availability
of every Playwright font package. Local hosts must provide their own browser
runtime dependencies. Removing APT from this step addresses the observed package
download blockage; it does not eliminate browser-download or application failures.
