# Agent Note: macOS CI Image Availability

Status: implemented

## Problem

The macOS 26 ARM64 lanes failed to acquire hosted runners in two attempts of
[run 41854705592](https://github.com/codetreker/daynight/actions/runs/41854705592).
Both ordinary and installed jobs had no assigned runner and executed zero steps,
leaving required macOS validation unavailable before checkout.

The [C1 platform requirement](../../../../docs/spec/daynight.md#c1-包与平台) requires
Apple Silicon ARM64 without requiring macOS 26. Another supported ARM64 image
can preserve that boundary while changing the selected hosted image.

Native execution also exposed a preparation precondition in identity-swap
fixtures: renaming their read-only cache directory could fail before the product
identity guard was exercised. The fixture must create the intended replacement
portably while preserving the original read-only state seen by that guard.

## Decision

The native macOS phases select explicit standard `macos-15`. The
[pinned image catalog](https://github.com/actions/runner-images/blob/9df30d63b790ea2057d1f50295a8f8a9a303bd88/README.md#L30-L47)
lists it as macOS 15 ARM64, and the
[pinned runner table](https://github.com/github/docs/blob/e44c283a7f901f63aead1ea13cf9062956706e24/data/reusables/actions/supported-github-runners.md#L1-L88)
identifies this GA standard runner as free for public repositories. It requires
no larger-runner configuration.

This replaces the macOS 26 image selected by the
[ARM64 support decision](2026-11-04-macos-arm64-support.md), preserving its
Apple Silicon boundary and independent Darwin ARM64 guards. The
[earlier capacity decision](2026-11-03-macos-hosted-runner-capacity.md) retains the
Intel, bootstrap and fixture-lifecycle history. Complete ordinary and installed
suites and the [logical phase responsibilities](2026-11-04-parallel-native-cli-validation.md)
remain. The later [single-allocation decision](2026-11-05-single-macos-native-allocation.md)
places both phases in one 20-minute job with separate 10-minute validation
bounds. Race policy and final checks retain their settings. The
[development guide](../../../../docs/development.md) owns the current image and
validation commands. There is no automatic fallback selection mechanism.

### Portable identity-swap fixtures

[Apple's rename documentation](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/rename.2.html)
records the write-disabled directory restriction even when a rename keeps the
same parent. The fixture actor uses the handle bound to its original cache inode
to enable write permission only for the rename, then restores `0555` in `finally`
before the product operation resumes. A swap intercepted during `chmod` restores
that state first, then delegates the product's requested mode through the same
original handle. The held-inode `0755` proof, foreign-directory `0555` state,
data and identity assertions retain their original meaning.

The product cleanup algorithm and refusal behavior remain unchanged. The actor
must complete the actual swap before its guard assertions can establish the
intended interleaving; an operating-system setup error cannot substitute for
that observation. This is a portability precondition for qualification on the
selected native image, with fresh macOS execution still required.

## Alternatives

**Retain `macos-26` or use `macos-latest`.** The current alias also selects macOS
26 ARM64. The earlier explicit choice preserved the OS major version while
restoring ARM64; repeated acquisition failure now motivates an explicit 15 image
within the same supported architecture.

**Use Intel.** Intel macOS falls outside the supported platform boundary, and
previous native comparisons exposed a suite-wide slowdown on that architecture.

**Use macOS 14.** The pinned catalog states that GitHub Actions macOS 14 images
retired on November 2, 2026.

**Use paid larger runners.** This introduces a different runner class and
cost/configuration responsibilities outside the standard hosted-runner model.

**Add generic fallback scheduling.** A selection protocol would introduce new
scheduling and evidence rules without proof of independent capacity pools.

## Consequences

Native macOS evidence targets macOS 15 ARM64, with actual image, architecture,
toolchain and tested source retained in receipts. Hosted capacity remains under
GitHub's control: catalog support does not prove independent pools, an official
capacity workaround or guaranteed allocation. The selected image requires real
allocation and complete native-suite results. Acquisition annotations remain
distinct from application test failures, and component probes cannot replace
that source-bound execution.
