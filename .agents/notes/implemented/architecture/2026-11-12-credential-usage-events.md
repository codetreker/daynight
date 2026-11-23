# Agent Note: Credential Usage Event Boundaries

Status: implemented

## Problem

Credential activity must represent real successful use without changing authentication,
authorization or refresh outcomes. A refresh candidate alone cannot establish that its
transaction committed, and long-lived requests cannot defer admission diagnostics until
completion.

## Decision

HTTP PAT/API OAuth and MCP PAT/OAuth admission record once after successful
credential validation, before business processing. API user WebSocket marker
admission records at that same HTTP boundary; internal polls and rechecks do not.
OAuth uses the actual grant identity. The refresh lifecycle observes
its real rotation candidate after the final transaction returns: a confirmed commit records
it even with a cleanup error, a known non-commit does not, and an unknown outcome produces
only a safe correlated fault. Both production lifecycle instances share the App recorder.
Protocol boundaries publish request-local faults before continuing. The
[authentication design](../../../../docs/design/daynight-auth.md#真实凭据使用事件)
owns event timing, exclusions and failure semantics.

## Alternatives

**Record during credential validation or the refresh transaction.** Internal credential
rechecks would appear as client use, and metadata failures could affect the original
transaction. A candidate inside a transaction also cannot prove that commit succeeded.

**Treat an unknown commit as a successful use.** A lost commit confirmation can mean either
outcome, so recording the candidate would present an unverified event as successful.

## Consequences

Confirmed rotation remains a use even when the response is lost. An unknown commit may have
succeeded without advancing usage metadata; its fault is observable and later valid use can
advance it. The bounded recorder may lose samples during faults, as described in the
[recorder decision](2026-11-12-credential-usage-recorder.md).
