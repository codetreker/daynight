# Agent Note: Observe Worker task tag filters in Web

Status: implemented

## Problem

A saved Worker tag filter and a Worker report are independent facts. A saved target does not prove that the Worker applied it, and an older report cannot identify the names it applied. Configuration edits also need to preserve the filter and future members without changing it.

## Decision

The Web configuration panel displays the saved filter read-only and compares its canonical semantic digest with the reported application item. A panel-owned WebCrypto operation isolates results by account scope, Worker and target semantics. Checking and calculation failure remain visible and prevent an applied summary; the save receipt remains independent of this derived work. Missing service support and absent Worker observation are distinct. Other edits merge into the original source without rewriting the filter.

## Alternatives

**Treat a successful save as application.** The Worker can be offline, unsupported, or still applying an earlier target, so the resulting status would be misleading.

**Calculate the digest during response parsing or receipt confirmation.** A crypto failure or delay would then obstruct a confirmed configuration write, even though it only affects derived presentation.

## Consequences

The panel can show current target names only when the digest matches; an older digest is described as different without exposing it or guessing its names. Unknown source data remains preserved and can keep the aggregate unconfirmed. The independently calculated digest adds an asynchronous checking state.
