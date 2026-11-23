# Agent Note: Web Worker review participation

Status: implemented

## Problem

An account needs to control a Worker's participation in PR review from its
configuration page, including while the Worker is offline or its cloud
configuration is uninitialized. Saving this preference must not submit or discard
unrelated configuration and prompt drafts.

## Decision

The configuration page presents the independently versioned
[review participation resource](../../../../docs/design/worker-review-participation.md)
between the saved configuration response and runtime settings. The control
retains the last confirmed value while saving, and reconciles conflicts and
unknown outcomes by reading the current resource before accepting another user
action. The [Web specification](../../../../docs/spec/daynight-web.md#云端运行配置)
owns the visible behavior. The [resource decision](2026-11-19-worker-review-participation.md)
owns the independent server preference and its versioning rationale.

## Alternatives

**Include the switch in the configuration form.** This would tie the preference
to the unrelated configuration revision and save operation, and make it
unavailable when that configuration has not been initialized.

## Consequences

The page can manage the preference independently of runtime configuration,
telemetry and drafts. A successful save confirms only server state; a compatible
Worker applies it after a successful poll. A read after an unknown write shows the
current value without proving the original request succeeded.
