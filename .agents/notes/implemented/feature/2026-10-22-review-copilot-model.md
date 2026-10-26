# Agent Note: Configurable Copilot review model options

Status: implemented

## Problem

Review operators need to select a Copilot model and its reasoning effort for
their running reviewer. Supported values depend on the installed Copilot CLI,
the authenticated account and the selected model. A local enumeration would
become stale, while absent settings must preserve Copilot's own choices.

## Decision

The review projection of the shared YAML configuration accepts independent
optional top-level `copilotModel` and `copilotReasoningEffort` strings. Both use
the existing nonempty-string validator, rejecting nonstrings, null, empty or
whitespace-only values and NUL while preserving accepted strings exactly. The
values are opaque to Daynight. Copilot owns model availability, effort levels
and model/effort compatibility. Its pinned
[model reference](https://github.com/github/docs/blob/5815d11586b0796688963a98c889680e60d72dc4/content/copilot/reference/copilot-cli-reference/cli-command-reference.md#L710)
defines model selection and `auto`; the
[effort reference](https://github.com/github/docs/blob/5815d11586b0796688963a98c889680e60d72dc4/content/copilot/reference/copilot-cli-reference/cli-command-reference.md#L694)
defines the reasoning-effort flag and its alias. The
[programmatic reference](https://github.com/github/docs/blob/5815d11586b0796688963a98c889680e60d72dc4/content/copilot/reference/copilot-cli-reference/cli-programmatic-reference.md#L178)
explains that only some models support reasoning effort.

The [configuration decision](../../archived/architecture/2026-10-16-user-home-review-configuration.md)
records the startup-loading, command-specific projection and YAML-update choices
retained here. The shared parser recognizes both keys, while the server projection
validates only its own fields. Setup and repository registration preserve the
settings and comments. Invalid review values remain errors rather than triggering
configuration guidance. The values apply to every review repository in that
process and change only after restart.

The [Copilot execution decision](../../archived/architecture/2026-10-17-copilot-session-execution.md)
records the session-identity, discovery, invocation and failure-handling choices
retained here.
The formal review child independently adds `--model` and the original model
string when configured, and `--reasoning-effort` and the original effort string
when configured. Each flag and value is a separate argv entry through the existing
`shell: false` path. Both fields may be omitted, either may be set alone, or both
may be set. An omitted field contributes no corresponding argument and preserves
Copilot's selection. New sessions, resumes, retries and later revisions share the
same construction; skill discovery receives neither override.

Unsupported or unavailable values and incompatible model/effort combinations
retain Copilot's failure result and the existing attempt/error flow. The settings
add no SQLite field, session state or execution lifecycle.

The [requirements](../../../../docs/spec/daynight-review.md) own configuration
and invocation behavior; the [review design](../../../../docs/design/daynight-review.md)
owns its runtime and validation mechanisms. Installed-CLI acceptance uses native
controlled Copilot processes to observe YAML-to-argv transfer, discovery isolation
and retained-session behavior. It makes no real model request and does not
establish live model reasoning, effort support or account model availability.

## Alternatives

**Validate against static model and effort enumerations.** This could reject
obvious misspellings earlier, but requires releases to track Copilot's changing
options and still cannot decide account availability or model/effort
compatibility. Passing opaque validated strings keeps those decisions with
Copilot.

**Always pass `--model auto` when the model field is absent.** This gives the
application one explicit model-selection mode, but overrides Copilot's own
default or persisted choice. Omitting the argument preserves existing external
configuration; `auto` remains available when explicitly requested.

## Consequences

Operators can choose either model option without changing process supervision,
session identity or review publication. Local validation proves that each setting
contains a usable string, not that its value or combination will succeed. Copilot
therefore remains responsible for compatibility and availability failures and
their diagnostics. A running reviewer keeps its startup choices until restart,
including across retries and revisions. Controlled invocation checks and live
Copilot acceptance retain distinct evidence scopes.
