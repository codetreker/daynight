# Agent Note: Readable Copilot Permission Details

Status: implemented

## Problem

Copilot permission cards serialized both native permission and prompt envelopes.
The resulting bookkeeping and repeated command text obscured the operation a
user needed to approve, especially in narrow Session views.

## Decision

The Controller formats permission details before publishing the existing typed
interaction. Shell commands retain their full native text, followed by supplied
working directories, possible paths and URLs. File requests show their target
and available diff or new content. URL requests retain redirect origins; MCP
requests retain server, tool and opaque arguments. Native warnings and sandbox
bypass requests remain visible. A path prompt supplements the underlying
operation rather than replacing it.

Identical permission/prompt blocks appear once. Unknown or incomplete requests
retain readable native content, excluding only top-level identity, repeated
intention and session-button metadata. Business arguments are never recursively
filtered. The existing interaction codec rejects oversized or invalid content;
permission details are not silently shortened to fit a display budget.

Title selection, actions, authorization results, interaction identity and native
completion remain owned by the existing
[Copilot interaction mechanism](../architecture/2026-10-28-copilot-web-sdk-runtime.md).
The browser consumes the same plain-text detail field.

## Alternatives

**Keep serialized envelopes.** This preserves the raw payload but repeats the
operation among implementation fields and makes approval unnecessarily hard to
read on mobile.

**Extract only commands or paths.** This is compact but hides file changes,
redirect origins and native warnings that can change an approval decision.

**Truncate long approval content.** The shared display helper is suitable for
ordinary tool output, but applying it to approval content can hide the actual
operation. The existing protocol bound remains an explicit failure instead.

## Consequences

Common requests become readable without changing approval behavior or adding
provider-specific browser rendering. Specialized formatting must follow native
request fields; new request kinds fall back to readable content until their
presentation is explicitly supported. Large valid changes remain long, and
requests exceeding the existing protocol limit still fail visibly.
