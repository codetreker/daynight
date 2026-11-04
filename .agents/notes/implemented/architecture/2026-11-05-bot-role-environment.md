# Agent Note: Bot role preparation and CLI environment

Status: implemented

## Problem

A long-lived assistant must coordinate work from an ordinary directory without
assuming project ownership or confusing task state with execution capacity.
Rebuilding its role after an upgrade can change an existing conversation's
instructions. A correct role is also insufficient if its CLI resolves a
different configuration root, server or account from the hosting Worker.

## Decision

The Worker owns one versioned role template and selects exact persisted roles
before considering the current template. A known server role can restore lost
local preparation; an unconfirmed registration retains its local role. A
disagreement fails preparation and requires reconciliation of the original
registration. The helper validates Unicode, byte size and digest and returns an
immutable copy. It does not own registration or persistence.

CLI environment preparation binds DN_CONFIG_DIR to the target Worker's paths,
uses ordinary CLI configuration and authentication, verifies server and current
principal, and probes the effective CLI through bounded help commands. Existing
alias preparation and native environment rules remain the owners of executable
selection. Credentials never become role parameters. The
[requirements](../../../../docs/spec/bot-role-environment.md) own observable
behavior; the [design](../../../../docs/design/bot-role-environment.md) owns the
consumer interfaces and cleanup responsibilities.

## Alternatives

**Regenerate the current template on every launch.** This avoids retaining the
first preparation but changes a frozen conversation on Worker upgrades and
cannot reconcile a registration whose response was lost. Persisted text,
revision and digest must survive that boundary.

**Use a server role despite conflicting local preparation.** This would make
the server win silently while hiding a registration identity or storage
mismatch. Exact disagreement must stop the launch until reconciled.

**Require an assistant-specific skill or operation list.** That would duplicate
CLI discovery and restrict otherwise authorized requests. The existing skill
supplies applicable task workflows, while help describes the actual commands.
Ordinary queries do not need a Goal.

## Consequences

The template can evolve for unprepared Bots without rewriting existing roles.
Checks fail before startup when configuration or authentication is observably
wrong, while preserving real provider homes and account permissions. Each
preparation incurs read-only identity and CLI probes. These observations cannot
prevent later user changes to global configuration.

The hosting consumer must persist preparation before registration, reconcile
unknown outcomes, inject the server-frozen text, and release owned aliases only
after descendants stop. Provider lifecycle, durable Bot inventory and complete
hosting are separate consumers; this module neither schedules work nor proves
that a model follows the role. The shared role transport remains owned by the
[Controller role decision](2026-11-04-controller-role-instructions.md).
