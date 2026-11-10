# Agent Note: Step CLI Text Process Proof

Status: implemented

## Problem

The former optional server-side Step text test exercised the real CLI process as
well as server admission and persistence. The CLI's argument, configuration,
transport, output and exit behavior needs an independently runnable owner in the
CLI module.
The largest description can exceed operating-system argument size limits before
Node starts, preventing the same process proof on all supported platforms.

## Decision

The CLI module runs ten independent built Node entry processes against a static
HTTP plan. A test-only preload reads each private JSON argument file into
`process.argv` before the real entry loads. The plan checks the exact request and
supplies independent refusal or complete Step receipt facts. The original text
values and version sequence reach the real parser and transport; the fixture does
not implement server admission or persistence. Process trees, listener and files
are owned and cleaned up by the test.

The [Step limits decision](2026-11-10-step-limits-test-ownership.md) assigns
business admission and encoding to Core. The [layered deletion
decision](2026-11-10-step-cli-test-layered-removal.md) records the remaining
protocol, coordination and storage owners. Installed launcher tests separately
exercise representative native arguments and packaging.

## Alternatives

**Pass all text in the operating-system argv.** This would retain the original
launch mechanism for every value but can fail before the CLI starts because of
platform argument limits.

**Call the CLI in the test process.** This avoids argument limits but loses the
real Node entry, process output, exit and cleanup observations.

**Repeat the full matrix through installed launchers.** Packaging and native
argument handling already have representative coverage; repeating the largest
values would also retain the operating-system argument limit.

## Consequences

The test verifies exact strings after preload, not operating-system acceptance
of the largest argv. Static responses cannot establish server refusal rules or
physical preservation after rejection; those remain with their respective
owners. Ten real launches add routine CLI test cost without a claimed CI speedup.
