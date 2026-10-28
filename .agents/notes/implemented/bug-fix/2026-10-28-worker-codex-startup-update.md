# Agent Note: Disable Worker Codex Startup Update Checks

Status: implemented

## Problem

Codex can present an interactive update choice before accepting task input.
An unattended worker cannot reach its task composer while that choice is open,
even when native permissions, directory trust and hooks are already configured.

## Decision

The shared worker argument builder supplies `-c` and
`check_for_update_on_startup=false` as separate Codex arguments for both fresh
and resumed launches. They follow configured arguments and fixed permission
flags, so configured overrides cannot restore startup update checks. The final
trusted-project override and the `--no-daemon [resume <session_id>]` prefix keep
their existing positions.

Codex's [configuration reference](https://developers.openai.com/codex/config-reference/#check_for_update_on_startup)
owns the setting. The worker passes it through Herdr's structured `agent.start`
arguments and verifies the returned argv. Task input remains a separate
`agent.prompt` operation. The [worker design](../../../../docs/design/daynight-worker.md#herdr-与原生会话)
owns the launch flow; the [full-access decision](../architecture/2026-10-27-worker-full-access.md)
continues to own permissions and directory trust.

## Alternatives

No alternative implementation was considered; the required solution is a
per-invocation Codex configuration override.

## Consequences

Worker Codex starts no longer wait for the startup update choice. The setting
applies only to these launches and does not change the user's global
`config.toml`, other Codex invocations or Copilot launches. Normal native startup
errors and task-input readiness checks remain visible. Codex installation and
updates remain the operator's responsibility.
