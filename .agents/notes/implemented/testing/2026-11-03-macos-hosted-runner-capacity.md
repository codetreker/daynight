# Agent Note: macOS Hosted Runner Capacity

Status: implemented

## Problem

A required macOS job failed to acquire a hosted runner before checkout or test
execution. GitHub reported runner acquisition failure and an arm64 capacity
advisory. The required gate therefore had no macOS validation result, even
though other platforms completed. Test deadlines cannot correct a failure that
precedes test execution.

The Intel runner then exposed a package-manager bootstrap failure before
workspace installation. The setup action's older bootstrap checked standalone
binary identity even when the JavaScript engine would run. Its self-update
returned without replacing that bootstrap because the project already declared
the requested pnpm version. This led to verification of an unpublished
Darwin x64 standalone package, rather than a missing application dependency.

With bootstrap repaired, two installed suites charged real package preparation
and their complete behavior sequences to one callback. Repeated private PNPM
consumers also generated shims for dependency executables. PNPM's default shim
generator reads an entire executable as UTF-8 before inspecting its first line;
that work can be expensive for bundled native or JavaScript executables.

## Decision

The [checks workflow](../../../../.github/workflows/checks.yml) selects the
standard `macos-26-intel` runner for its macOS lane. This preserves macOS 26 and
the complete native and installed CLI suites while selecting the Intel pool.
The [official standard runner table](https://github.com/github/docs/blob/9e46fa10eb2ed55c59bf6770a220477c91e1b3bf/data/reusables/actions/supported-github-runners.md)
and [runner image catalog](https://github.com/actions/runner-images/blob/a2d4955654f519bd5b559bffaea60d9f90156630/README.md#L19-L47)
list this label as a standard hosted runner. It requires no larger-runner
registration.

The native lane uses
[pnpm/action-setup v6.1.1](https://github.com/pnpm/action-setup/tree/73e46992e05b19abd31f2f3c20e0e7370d762115)
with the existing requested pnpm version, `11.28.6`. The action patch refreshes
its bootstrap to a version with engine-specific identity verification. Workspace
installation retains `--frozen-lockfile`; application dependencies and the
workspace lockfile retain their existing versions and integrity records.

The [private installation fixture](../../../../packages/daynight/test/fixtures/installed-cli.ts)
uses PNPM's supported `--config.prefer-symlinked-executables=true` setting.
Its POSIX executable links avoid the repeated
[whole-file shim inspection](https://github.com/pnpm/pnpm/blob/fe4a0c232384289de82be3d502896ca7e070050c/pnpm11/bins/cmd-shim/src/index.ts#L236-L252).
PNPM retains its existing Windows linking semantics. These consumers still
perform real pack/install with the full package manifest and dependencies,
private directories and source/hash receipts. The independent installed e2e
suite retains default PNPM shim coverage; real npm global updates remain
unchanged. No installed tree or mutable scenario state is shared.

Project/task's pack/install/receipt preparation and self-update's three packed
versions plus initial npm global installation belong to case-owned setup hooks.
Their callbacks retain the ordered business, failure, state-transition and
identity assertions. Preparation, callbacks and teardown have explicit local
owners. Teardown aborts pending work and waits for preparation and behavior to
settle before final child, registry and directory cleanup. Success receipts are
published only after cleanup is verified. Errors from work and cleanup retain
their original chain.

Update subprocesses have owned POSIX groups. Termination still finds live
parents' descendants, then uses the existing bounded group termination and
reaping helper, including when a launcher has exited but descendants retain its
stdio. An unbounded exit-to-close join would block all remaining teardown; the
original stdio risk existed before setup moved, and explicit lifecycle joins
make bounded reaping necessary.

The repository requires native Linux, macOS and Windows validation. It does not
require a particular macOS CPU architecture. This lane records Darwin x64
evidence; it does not establish Apple Silicon compatibility. Environment
receipts retain the actual OS, architecture, toolchain and tested source.

The 180-second hook/callback, 120-second command and 10-minute job limits
retain their settings. Setup and behavior consume separate hook/callback allowances;
this changes budget ownership and does not preserve the old scenario-total
allowance or imply less total work. Ubuntu still builds the runtime matrix's
packed artifact. The [development guide](../../../../docs/development.md) owns
validation commands and the native platform description.

## Alternatives

**Retain `macos-latest`.** The alias currently selects macOS 26 arm64, whose
runner acquisition failed. An unchanged retry would continue depending on the
same pool and would not change the acquisition conditions.

**Add a standalone binary record to the application lockfile.** The selected
JavaScript engine does not execute that binary, and the requested Darwin x64
standalone package is unpublished. The setup bootstrap requires correction;
inventing a package identity would misrepresent the dependency graph.

**Select `macos-15-intel`.** This is also a supported standard Intel label, but
changes the OS major version as well as the architecture. The macOS 26 label
preserves the current OS coverage.

**Increase callback or job limits.** That retains preparation/behavior coupling
and does not remove repeated installation work. The chosen partition preserves
the existing numeric limits, while the full job must still fit its own bound.

**Share installed trees or introduce a seed protocol.** Installed suites mutate
their own resources and update state. Shared mutable installations would break
isolation; a new cache/provenance protocol is unnecessary for the existing
case-owned setup and supported package-manager linking preference.

## Consequences

The macOS lane has an explicit OS major version and architecture. Its image
continues receiving normal GitHub image updates. The full native CI must pass
on the selected runner before the configuration is accepted; catalog support,
component probes and dependency targets do not prove whole-suite execution.

Intel capacity remains controlled by GitHub. A future acquisition failure must
be diagnosed from native job annotations. Apple Silicon validation would need
its own supported execution environment. Local phase measurements do not prove
native-platform speed, and changes in dependency resolution time must not be
attributed entirely to executable-link selection.
