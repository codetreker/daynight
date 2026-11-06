# Agent Note: CLI Artifact Validation Boundary

Status: implemented

## Problem

Installed-package validation mixed packaging and launcher checks with extensive
client protocol, local-state, failure and concurrency scenarios. Their result
could not identify whether a failure came from the artifact or a CLI behavior,
and a simulated service did not establish product integration. Obsolete Go
acceptance preparation also left cross-module inputs and evidence references.

## Decision

The installed CLI phase verifies package installation, delivered resources,
launchers and a representative npm update. Runtime checks exercise supported
Node versions and the installed dependency graph. Real shell checks verify
completion loading and Tab integration on Bash 4.2, modern Bash and zsh.
Client behavior and local process, Git and SQLite rules belong to CLI module
verification rather than the artifact matrix. Ordinary CLI tests remain in their
existing entrypoint. Static response fixtures used by CLI tests are local to the
CLI, and the CI selector retains shared Web consumers of CLI source and fixtures.

## Alternatives

**Keep the behavior matrices in installed acceptance.** These cases exercise a
real launcher but duplicate module ownership and multiply business and failure
scenarios across artifact platforms. Small integration checks retain evidence
that delivered entrypoints and dependencies are usable.

**Treat mock HTTP acceptance as product E2E.** A controlled service cannot
prove interaction with the real service or browser. Product integration requires
its own real components and normal shared-data journeys.

## Consequences

Installed validation no longer proves every removed client behavior. The original
immutable tests and assertion-level inventory identify the behavior that must be
covered by module-owned tests, without changing production behavior or treating
similar test names as proof of equivalence. Artifact checks continue to fail on
missing package resources, unusable launchers and shell integration failures.
