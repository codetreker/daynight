# Agent Note: Project README and Reference Ownership

Status: implemented

## Problem

The root README combines the project introduction with detailed command behavior,
development procedures and validation records. Readers must pass implementation
details before learning what the project does or how to use it. Operational
instructions still need an accessible, maintained owner.

## Decision

The [root README](../../../../README.md) introduces the project, its available
capabilities, first-use workflow and component relationships. It retains
documentation conventions, development entry points, package-version rules,
the CI routing table and validation boundaries used by existing references.

The [CLI README](../../../../packages/daynight/README.md) owns installed command
usage, configuration, skill installation and the review lifecycle. The
[development guide](../../../../docs/development.md) owns detailed source-build,
release and validation procedures. Existing server, Web and deployment READMEs
retain their component responsibilities. Requirements, designs and decision
notes remain the owners of product contracts and implementation rationale.

## Alternatives

**Keep the command manual in the root README.** Shortening only its introduction
would leave operational reference material dominating the project entry point.

**Remove detailed instructions and rely on CLI help.** Help describes invocation
syntax but cannot replace the retained configuration, recovery, release and
evidence guidance.

## Consequences

New readers can find the project purpose and a usable setup sequence before
consulting reference material. Existing linked root sections continue to offer
substantive guidance and direct readers to the detailed owners. Relocated links
must resolve from their new directories. Product summaries require synchronization
with their owning documentation when capabilities change; run-specific delivery
observations remain with source-bound artifacts and their PR or CI run.
