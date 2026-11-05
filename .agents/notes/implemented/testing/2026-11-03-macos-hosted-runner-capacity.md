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

At adoption, the [checks workflow](../../../../.github/workflows/checks.yml)
selected the standard `macos-26-intel` runner for its macOS lane. This preserved
macOS 26 and the complete native and installed CLI suites while selecting the
Intel pool. That runner selection is superseded by the [ARM64 support
decision](2026-11-04-macos-arm64-support.md); the bootstrap, executable-link and
fixture-lifecycle decisions below remain in effect.
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

At adoption, the [private installation fixture](../../../../packages/daynight/test/fixtures/installed-cli.ts)
used PNPM's supported `--config.prefer-symlinked-executables=true` setting.
Its POSIX executable links avoided the repeated
[whole-file shim inspection](https://github.com/pnpm/pnpm/blob/fe4a0c232384289de82be3d502896ca7e070050c/pnpm11/bins/cmd-shim/src/index.ts#L236-L252).
PNPM retained its existing Windows linking semantics. Each consumer performed
real pack/install with the full package manifest, private directories and
source/hash receipts, while the independent e2e suite retained default shim
coverage. The [shared preparation decision](2026-11-04-shared-installed-cli-preparation.md)
replaces that repeated-preparation premise for Vitest acceptance: one canonical
default-shim installation serves private runtime state and isolated writable
package views. Standalone callers retain owned preparation and the supported
linking preference; real npm global updates remain unchanged.

Project/task's private runtime/view preparation and self-update's three packed
versions plus initial npm global installation belong to case-owned setup hooks.
The shared Vitest installation has its own global setup and teardown owner.
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

This decision originally treated native Linux, macOS and Windows validation
as an OS requirement without a particular macOS CPU architecture. The Intel
lane therefore recorded Darwin x64 evidence and made no Apple Silicon claim.
The [ARM64 support decision](2026-11-04-macos-arm64-support.md) replaces that
architecture-independent premise. Environment receipts continue retaining the
actual OS, architecture, toolchain and tested source.

The 180-second hook/callback and 120-second command limits retain their settings.
The [native phase decision](2026-11-04-parallel-native-cli-validation.md)
originally replaced the combined platform job with independent ordinary and
installed jobs, each bounded to 10 minutes. Their separate ceilings and duplicated
bootstrap changed the earlier total platform budget. The later
[single macOS allocation decision](2026-11-05-single-macos-native-allocation.md)
keeps both complete phases and their validation bounds on one 20-minute macOS
job; Linux and Windows retain independent jobs. Setup and behavior consume separate hook/callback allowances;
this changes budget ownership and does not preserve the old scenario-total
allowance or imply less total work. Ubuntu still builds the runtime matrix's
packed artifact. The [development guide](../../../../docs/development.md) owns
validation commands and the native platform description.

## Alternatives

**Retain `macos-latest`.** At adoption, the alias selected macOS 26 arm64, whose
runner acquisition had failed. An unchanged retry would continue depending on the
same pool and would not change the acquisition conditions.

**Add a standalone binary record to the application lockfile.** The selected
JavaScript engine does not execute that binary, and the requested Darwin x64
standalone package is unpublished. The setup bootstrap requires correction;
inventing a package identity would misrepresent the dependency graph.

**Select `macos-15-intel`.** The catalog also documented this standard Intel
label, but it would have changed the OS major version as well as the architecture.
The macOS 26 selection preserved the OS coverage at adoption.

**Increase callback or job limits.** That retains preparation/behavior coupling
and does not remove repeated installation work. The chosen partition preserves
the existing numeric limits, while the full job must still fit its own bound.

**Share installed trees or introduce a seed protocol.** At adoption, installed
suites mutated their own resources and update state. Sharing their mutable
installations would have broken isolation, while case-owned setup and supported
package-manager linking already addressed the observed bootstrap and callback
problems. The later [shared preparation decision](2026-11-04-shared-installed-cli-preparation.md)
separates immutable installation ownership from private runtime and package
mutation, addressing repeated work without sharing mutable package files.

## Consequences

The original Intel selection made the lane's OS major version and architecture
explicit while retaining normal GitHub image updates. Capacity remained under
GitHub's control, and native acquisition annotations were required to diagnose
a failure before execution. The later [ARM64 support
decision](2026-11-04-macos-arm64-support.md) owns the support policy, and the
[image availability decision](2026-11-05-macos-ci-image-availability.md) selects the
current standard ARM64 image. Full native CI must pass on that runner before its
configuration is accepted; catalog support, component probes and dependency targets do not prove
whole-suite execution.

Local phase measurements do not prove native-platform speed, and changes in
dependency resolution time must not be attributed entirely to executable-link
selection.
