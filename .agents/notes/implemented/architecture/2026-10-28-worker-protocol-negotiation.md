# Agent Note: Worker Protocol Negotiation

Status: implemented

## Problem

A new server must preserve existing CLI and Herdr worker operation without
requiring every installed or running client to upgrade at once. Original CLI
parsers reject unknown WorkerClaim fields, including an explicit Herdr mode.
They also cannot represent a Web backend or Claude provider safely. Making
unsupported claims disappear from a worker's execution inventory would cause
its reconciliation logic to treat live resources as abandoned.

## Decision

Task requests explicitly negotiate the expanded WorkerClaim representation with
`Daynight-Worker-Protocol: 2`. Unnegotiated responses retain the original Herdr
Codex/Copilot representation. Ordinary reads retain every task, but expose no
worker summary when the original representation cannot preserve its provider and
backend. This presentation never removes or changes the stored claim.

Worker inventory and candidate discovery have different responsibilities.
Inventory fails explicitly if its worker owns an unsupported claim; it cannot
omit ownership evidence. Legacy candidate discovery skips unsupported historical
claims and advances across empty filtered pages, so those entries cannot starve
other tasks. This filtering uses the existing worker discovery query and does
not change ordinary list or detail behavior.

Unnegotiated mutations carry a service restriction checked against the actual
claim under the project write lock, after existing input and version validation.
New claim descriptors must also fit the old protocol. A missing summary therefore
cannot authorize reclaiming, completing, deleting or modifying an unsupported
execution. The restriction does not replace authorization or native stopping
proof.

This partially supersedes the client-first rollout requirement in the
[claim-frozen mode decision](2026-10-27-task-session-mode-contract.md). Its frozen
mode, execution identity and backend ownership remain unchanged. The
[session protocol design](../../../../docs/design/task-session-protocol.md#升级与安全失败)
owns request negotiation, projection and pagination details.

## Alternatives

**Require every client to upgrade before the server.** This made the original
strict parser usable with the expanded response, but required coordination of
all installed clients and long-running worker processes. Keeping the default
mode at Herdr did not avoid the new field, and reverting only the CLI could not
restore compatibility.

**Reject every read containing an unsupported claim.** This preserved ownership
visibility but made ordinary task lists and details unusable in mixed projects,
even when the user only needed task metadata.

**Hide unsupported claims from every response.** This kept old parsers running,
but an incomplete worker inventory could trigger cleanup and a hidden historical
claim could repeatedly attract rejected claims. Inventory must fail closed;
candidate discovery must instead keep scanning compatible work.

## Consequences

Existing clients continue using their supported tasks and Herdr executions.
Only consumers of new provider or Web capabilities need a supporting client.
Legacy task summaries intentionally cannot describe those executions, and their
mutations fail without changing the claim. Operators cannot use this projection
to downgrade an already running Web worker into a Herdr worker.

The server retains two response representations and explicit handling of the
original worker discovery query. Candidate filtering can require more than one
underlying page read. Cursor order and limits remain those of the underlying
scan, and no filtered empty page advertises a continuation cursor. Changes to
legacy worker query shapes or task mutation entry points require corresponding
compatibility checks.
