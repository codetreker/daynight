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

The adopted [native dependency requirements](../../../../docs/spec/development-snapshot-native-layout.md)
require each physical source package to have its own
`.dev-store/<id>/node_modules/<package-name>/` directory and resolved dependencies
within its package scope. Named paths must support native relative library
lookup while keeping different versions and peer resolutions separate. All
dependency links must remain inside the snapshot, and copied package files must
not depend on mutable source links.

The requirements also mandate separate, bounded Node processes that exercise
sharp with an in-memory image, query an in-memory better-sqlite3 database, and
load Koffi before publishing the development entry. Native failures must identify
the module and preserve the existing entry. Separate processes prevent an
already loaded source library from masking broken snapshot paths.

The implemented artifact is the requirements contract. The installer still uses
numbered package roots and checks only the version before publication; it does
not yet enforce the named layout or native validation requirements. A native
load failure can therefore remain undetected until after the entry is replaced.

This refines the dependency closure established by the
[original development CLI decision](../../archived/architecture/2026-10-29-local-development-cli.md),
whose independent snapshots protected running processes from mutable build
outputs. The [development guide](../../../../docs/development.md#local-development-cli-channel)
owns the current installation and snapshot lifetime behavior.

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

The requirements establish native readiness as a condition of successful
installation. Enforcing them requires additional child-process checks before
the existing atomic publication boundary. Version-only success cannot establish
that the current snapshot meets this condition or protects an old entry from a
native loading defect.

Representative native checks cannot establish every command or Provider
lifecycle. Controller acceptance requires an actual bounded conversation,
normal stop and archive. Existing running processes still require their original
snapshots and fixed Node executable to remain available. The requirements retain
macOS/Linux support without adding Windows launchers or changing the npm package.
