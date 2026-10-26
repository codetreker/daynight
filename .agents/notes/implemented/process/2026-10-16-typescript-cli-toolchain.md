# Agent Note: TypeScript CLI Toolchain

Status: implemented

## Problem

The CLI needs reproducible type checking, an executable package, strict
configuration handling, and native-platform verification before review runtime
components can share its configuration and command boundary.

## Decision

The repository uses a pnpm workspace with application code in
`packages/daynight/`, Node.js 24 LTS, pinned dependencies, TypeScript ESM with
NodeNext module resolution, and emitted JavaScript. The `daynight` and `dn`
package bins point to the shebang-bearing `dist/main.js`. Vitest executes source
tests and compiled CLI probes; the test command builds before running them. A script-relative cleanup
removes `dist/` before compilation so moved modules cannot remain in packed
artifacts. Source tests follow client, command and platform module ownership;
tooling tests retain build and version-policy validation. The pnpm dependency store
is local to `.tmp/pnpm-store`.

The initial package engine restricted installation to Node.js 24. The
[runtime support decision](../bug-fix/2026-10-26-node-runtime-support.md)
replaces that restriction with Node.js `>=22` and adds strict installed-artifact
checks across Node.js versions, with native binary requirements documented.
Source development and native application validation retain Node.js 24.

YAML parsing is followed by explicit field/type/path validation. Omitted numeric
settings use documented defaults; invalid supplied values fail. Existing
path components must be directories, while missing clone directories remain
valid. Filesystem errors retain their causes across platform-specific error
codes. Physical directory identity and ancestry detect existing aliases and
state overlap. Missing destinations under one physical ancestor with equal
component counts use a temporary candidate-path probe: one spelling is created
inside an owned sandbox and the other is looked up by the filesystem. Created
directories are recorded and removed deepest-first without recursive deletion.
Creation, inspection, and cleanup failures remain visible. No platform casing,
JavaScript lowercase, or Unicode-normalization rule replaces actual lookup.
The [configuration design](../../../../docs/design/daynight-review.md) owns the schema
and path rules.

The [client composition decision](../architecture/2026-10-20-client-command-composition.md)
assigns root help/version to the client and operation loading to each command.
The review module supports argument validation, configuration loading,
[configuration-only repository registration](../feature/2026-10-18-add-repo-configuration.md)
and [local persisted status listing](../feature/2026-10-18-review-status-listing.md).
The [self-update command](../feature/2026-10-20-cli-self-update.md) updates only its
verified npm global installation before home, configuration or review runtime
loading. The listing parses configuration without physical path probes and reads
a single SQLite transaction without initializing, migrating or recovering application state.
It requires no review instance lock or external executables. Review mode acquires
the instance lock, opens SQLite and runs the
[foreground coordinator](../architecture/2026-10-17-foreground-review-coordination.md).
Configuration failures report their filename and preserve the original cause.

When the CLI is selected by the [module-scoped CI decision](2026-10-21-module-scoped-pr-ci.md),
GitHub Actions runs type checking, build, and tests on native Linux, macOS, and
Windows. Explicit `pnpm test:apfs` diagnostics on macOS mount temporary
case-sensitive and case-insensitive APFS images and verify their actual lookup
behavior before exercising configuration validation. Routine tests and the CLI
matrix leave image diagnostics unselected, following the
[native development coverage decision](../testing/2026-10-23-native-development-filesystem-coverage.md);
non-mounting path and cleanup tests remain. The final `checks` job accepts only success or skipped from every
preceding job, including the CLI matrix and dedicated shell completion job.
Main pushes select all modules. The [CI simplification decision](../simplification/2026-10-21-ci-gate-simplification.md)
owns the final job-result gate and PR-only version enforcement.
Actions are pinned to the inspected commits:
[checkout](https://github.com/actions/checkout/tree/3d3c42e5aac5ba805825da76410c181273ba90b1),
[setup-node](https://github.com/actions/setup-node/tree/949feb2413d6458794dcd2491c4babbbce0c15c1),
and [pnpm setup](https://github.com/pnpm/action-setup/tree/ea17c68df8912ef543352723c149a84f56e3d413).

On PRs, the Linux verification job checks package version increases before the
ordinary checks, using the event's explicit base and head commits. Release inputs
are production source, package manifests, TypeScript build configuration, the workspace definition, dependency lock and package-manager
configuration and the package build-cleanup script. The
[README](../../../../README.md#package-versions) owns the exact
scope and local command. Tests, documentation and validation scripts alone do
not change the shipped application. Conservative manifest and lockfile matching
keeps dependency and build changes visible without reconstructing a production
dependency graph.

PR change detection compares merge-base to the explicit event head, while its
version comparison uses the event's target revision. Target-only changes do not
become PR changes, and a version already present on the target cannot satisfy a
new code revision. The local script's push mode compares the complete
before/after range. Full checkout history and explicit commit reads avoid
synthetic merge versions, shallow-history guesses and uncommitted state. The
[Git diff documentation](https://git-scm.com/docs/git-diff) defines the merge-base
comparison; the [GitHub event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)
distinguishes the synthetic merge SHA from the PR head.

The directly declared `semver` runtime dependency validates and orders versions
for self-update and the package-version gate, including prereleases. Build
metadata alone does not increase version precedence. Invalid manifests or missing commits fail instead of bypassing the
check. The local push mode validates its first version when no predecessor
exists. Version-check failures fail the PR's Linux job and the final `checks` job.
The original toolchain ran this policy on main pushes as well; the
[CI simplification decision](../simplification/2026-10-21-ci-gate-simplification.md)
keeps the version decision in the reviewed PR while retaining full application
validation on main.

## Alternatives

**Compile a separate test tree for the built-in Node test runner.** This avoids
a test framework dependency but adds test-output layout, cleanup and command
handling alongside the production build. Vitest provides source-test discovery
on each platform while subprocess tests still exercise emitted JavaScript.

**Make the incomplete review command wait indefinitely.** At the original
configuration-only stage, an idle invocation supplied no monitoring behavior or
failure signal. An explicit unavailable-coordinator error kept that stage from
implying a working reviewer. The integrated coordinator now owns the foreground
lifetime.

**Infer path case rules from the operating system or existing names.** macOS
supports both APFS variants, and a directory's name is looked up in its parent,
which can be on another volume. Empty destination ancestors provide no names
for a read-only probe. JavaScript lowercase comparison also misses Unicode
normalization aliases on APFS, while global normalization would conflate
distinct Linux filenames. Conditional candidate-path probing observes lookup
under the actual parent of the future clone without introducing native helpers
or platform commands.
Node's [filesystem guidance](https://nodejs.org/learn/manipulating-files/working-with-different-filesystems)
also recommends probing behavior rather than assuming it from the platform.

**Commit version changes automatically in CI.** This mutates the contributor's
branch, requires write credentials and chooses release intent without the
maintainer. A read-only failure keeps the version choice in the reviewed change.

## Consequences

Every release-affecting PR includes its version decision. Documentation and
test maintenance stay independent of release numbering. The gate verifies the
PR revisions supplied by the event; it does not publish packages or schedule
release tags. Native-platform checks still own application validation. The
separate [npm publishing decision](2026-10-20-npm-trusted-publishing.md) owns
manual release authorization, OIDC, artifact identity, and post-publication tags;
its workflow validates the CLI at the selected commit under the
[CLI publication-validation decision](2026-10-22-cli-publication-validation.md).

All implementation tasks share concrete build and validation commands. Tests
can inject home resolution and command boundaries without modifying an actual
user profile. Platform CI provides native process and filesystem evidence as
features are added; it does not establish live Copilot/GitHub behavior.
Validation can require write permission on an existing ancestor when ambiguous
missing destinations require a probe. Failure to create, inspect, or remove it
is an error; validation never accepts an uncertain case comparison silently.

The toolchain establishes the CLI/configuration foundation. The
[durable state module](../architecture/2026-10-17-durable-review-state.md)
adds SQLite persistence, and the
[Git manager](../architecture/2026-10-17-owned-review-worktrees.md) owns repository
and worktree operations. The
[Copilot adapter](../architecture/2026-10-17-copilot-session-execution.md) uses
`cross-spawn` for native and Windows command-shim execution with typed arguments
and stdin prompts. Continuous scheduling is connected through the foreground
coordinator; authorized live acceptance remains separate evidence. A task stays in progress through its PR review and closes only
after accepted integration.
