# Agent Note: Shared Installed CLI Preparation

Status: implemented

## Problem

Installed CLI acceptance files independently packed the same compiled package
and installed the same production dependency graph. Each preparation exercised
real packaging, but repeating it added package-manager startup, resolution and
linking work to native validation. The tests need independent configuration,
Git repositories, databases and writable package resources; those requirements
do not require repeating dependency installation.

## Decision

The acceptance Vitest configuration owns one real package preparation in global
setup. It packs the compiled CLI and installs its complete production manifest
with default PNPM command shims. The serializable installation receipt is
provided to isolated test workers. Global teardown verifies that the shared CLI
package's files remain unchanged, removes the installation and records the
actual preparation commands, source provenance and cleanup result.

Each acceptance consumer owns a private runtime directory and cleanup function.
Consumers that only read package files share the canonical entry and launchers.
The manual-removal, SQL-resource and review lifecycle consumers receive private
writable CLI package files. These views retain PNPM's relative package location,
share only dependency directories and rebase the copied default launchers'
absolute installation paths. Their receipts retain the canonical tarball and
source identity while recording actual view entry and launcher paths. Package
file mutation and runtime cleanup cannot remove or modify the shared package.

The standalone factory remains available to service acceptance and other
non-Vitest callers. It retains its owned pack/install, cancellation and
executable-link behavior. Real npm global-update acceptance still prepares its
multiple versions and performs genuine installation and replacement. The
[earlier hosted-runner decision](2026-11-03-macos-hosted-runner-capacity.md)
records why private linking was chosen when each file owned preparation; shared
Vitest ownership replaces that repeated-preparation assumption.

The [development guide](../../../../docs/development.md#validation) owns the
validation commands and evidence boundaries. Native launcher and writable-view
acceptance verifies both aliases, independent package bytes, runtime cleanup and
continued availability of the canonical installation. Existing SQLite and
review lifecycle tests exercise native dependencies through the private views.

## Alternatives

**Share the existing factory result unchanged.** Its root also owns runtime
state and its cleanup deletes the installation. Sharing that object would couple
state and let one completed suite remove another suite's executable.

**Copy the complete production dependency tree for every consumer.** Bundled
SDK and native executable trees are large. Private CLI bytes and shared
read-only dependencies preserve isolation without repeating those copies.

**Cache a preparation promise inside each worker.** Vitest isolates files in
separate workers, so process-local caching would still prepare multiple
installations and leave whole-suite cleanup ownership unresolved.

**Keep per-file installation and increase concurrency.** This retains repeated
work and adds resource contention. Preparation ownership can remove the work
while keeping the current worker and timeout settings.

## Consequences

Ordinary installed acceptance performs one canonical pack and production
installation per platform invocation. Each platform still prepares its own
native dependencies. The npm-update scenarios retain their separate operations.
The shared installation must remain available until all consumers and their
owned processes stop; only global teardown removes it.

Writable views depend on PNPM's installed package and generated launcher layout.
Cross-platform native acceptance must verify relocated launchers and dependency
resolution whenever that layout changes. Source and hash receipts describe the
real prepared artifact and each view, without claiming that a view was
independently packed or installed. Aggregate filesystem and package-manager
measurements overlap across workers, so they cannot be added as guaranteed
wall-clock savings.
