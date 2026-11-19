# Agent Note: Native Dependencies in Development Snapshots

Status: implemented

## Problem

A development installation could report success and print its version while
failing when Controller startup first loaded sharp. The copied Linux native
module could not find libvips even though both packages were present and loaded
successfully from the source dependency tree. Numbered package directories
preserved JavaScript dependency resolution but discarded the named sibling paths
used by the native module's relative RPATH. Version-only verification did not
exercise this dependency.

## Decision

The installer copies each physical source package into its own
`.dev-store/<id>/node_modules/<package-name>/` directory and connects its resolved
dependencies within that package's resolution scope. Package names remain
available to native relative library lookup, while separate physical packages
retain independent versions and peer resolutions. All dependency links stay
inside the snapshot; copied package files do not depend on mutable source links.

Before publishing the development entry, independent Node processes load and
exercise sharp with an in-memory image, query an in-memory better-sqlite3
database, and load Koffi. A failing check identifies its module and prevents
replacement of the existing development entry. Separate processes avoid a
previously loaded native library masking a broken snapshot dependency path.

This refines the dependency closure established by the
[original development CLI decision](../../archived/architecture/2026-10-29-local-development-cli.md),
whose independent snapshots protected running processes from mutable build
outputs. The [development guide](../../../../docs/development.md#local-development-cli-channel)
owns the installation and snapshot lifetime contract.

## Alternatives

**Keep numbered package roots and add JavaScript dependency links.** Node can
follow those links, but the native dynamic loader follows the binary's RPATH;
JavaScript resolution alone cannot repair the missing named library locations.

**Set LD_LIBRARY_PATH or install system libvips.** Both make the snapshot depend
on ambient runtime configuration and hide whether its copied closure is usable.
The installer must produce a self-contained dependency layout.

**Flatten packages into one named directory.** Native sibling lookup would work
for a single resolution, but different package versions and peer environments
could overwrite or resolve to each other. Separate package scopes preserve those
identities.

**Keep version-only verification.** It is inexpensive but does not load the
production native modules that failed during Controller startup.

## Consequences

Development installation performs additional bounded child-process checks and
retains the existing atomic publication boundary. A failed new snapshot cannot
replace a usable old entry. Existing running processes still require their
original snapshots and fixed Node executable to remain available.

The checks cover representative native runtime dependencies, not every command
or Provider lifecycle. Controller acceptance remains a separate runtime check.
The installer retains macOS/Linux support and does not add Windows launchers or
change the npm package.
