# Agent Note: Review Configuration Section

Status: implemented

## Problem

The shared CLI configuration contains service credentials and worker settings,
but review settings occupy its root. Generic names such as `repositories` and
`pollIntervalMs` obscure which command owns them and prevent the root from
expressing command ownership consistently.

## Decision

All review settings belong to a `review` mapping in `config.yml`, including
repository registration, numeric scheduling options and Copilot overrides.
Known root fields are `serverUrl`, `serverToken`, `workerId`, `worker` and `review`.
The shared parser validates YAML and the root mapping; each command validates its
own known field values and reports complete field paths. Unknown fields are
ignored and retained under the later
[unknown-field policy](../bug-fix/2026-10-27-ignore-unknown-configuration-fields.md).
Service and worker commands do not validate review-owned values.

Registration and interactive configuration edit nodes within `review`, retaining
comments and other sections. The interactive transaction compares
`review.repositoryRoot` and `review.repositories` before saving, preserving
concurrent edits to unrelated options. Missing sections support first-use
registration; explicitly malformed sections remain errors.

The [original configuration decision](../../archived/architecture/2026-10-16-user-home-review-configuration.md)
records the root-field layout's original circumstances. This decision replaces
that placement while retaining startup loading, path resolution and atomic
configuration writes. The [Copilot options decision](../feature/2026-10-22-review-copilot-model.md)
continues to own model and reasoning-effort semantics. The
[review design](../../../../docs/design/daynight-review.md#使用方式与配置)
owns the complete current format.

## Alternatives

**Move only the repository list.** This leaves review scheduling and model
options at the root and splits one command's configuration across two places.
Keeping all review-owned fields together makes ownership unambiguous.

**Accept both flat and nested fields.** This requires precedence and mixed-format
validation rules for the same settings. The format has one owner and one accepted
shape; existing files require an explicit manual move of the review settings.

## Consequences

Review and worker configuration use separate named sections without changing
their runtime configuration types. The original decision rejected existing flat
review settings to make the required relocation visible. The later unknown-field
policy ignores those entries; settings must still be moved together under
`review` to take effect, and the CLI does not migrate files.
Repository paths still resolve relative to the configuration directory, and
changing the YAML section does not alter SQLite data, clone locations, review
identity or a running reviewer's loaded settings. Examples, fixtures and active
documentation must use the same section structure.
