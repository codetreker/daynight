# Agent Note: Worker Detail Prompt Tab

Status: implemented

## Problem

Worker instructions and runtime settings are independent resources, but placing
both editors under Configuration makes the prompt harder to find and makes the
page organization suggest a dependency between them. Separating their entrances
must preserve drafts, navigation admission and the lifetime of dispatched writes.

## Decision

Worker detail presents Runtime monitoring, Configuration and Prompts as peer
tabs. A page-level editing coordinator owns both resource controllers and a
single Worker draft scope. Each tab enables its own resource reads; opened
editors remain mounted across tab changes. The coordinator combines dirty and
pending or uncertain states for navigation and owner retention while each
resource keeps its own save, discard and failure behavior. History stores only
an account- and Worker-bound tab selection. The
[Web requirements](../../../../docs/spec/daynight-web.md#我的-worker) and
[design](../../../../docs/design/daynight-web.md#worker-云端配置编辑) own the
observable behavior and mechanism.

This extends the [personal prompt editor decision](2026-11-09-web-personal-prompt-editor.md),
which established independent resources and shared navigation protection, and
the [reading history decision](../feature/2026-11-11-account-reading-history.md),
which established identity-bound Worker selections.

## Alternatives

**Ship an empty tab before moving the editor.** The intermediate tab has no
independent capability and does not complete the entrance users need.

**Split the editor migration from shared draft protection.** Independent guards
could produce duplicate confirmations or lose a hidden draft during navigation;
delivering the coordination with the tab preserves the existing guarantee.

## Consequences

Prompt editing is discoverable without loading runtime configuration, and
failures in either resource do not block the other. The shared coordinator must
track the last edited tab and both operation lifetimes so cancellation restores
the appropriate editor and one completed operation cannot release another.
The resource APIs and prompt save state machine remain independent; this page
organization does not make the two saves atomic.
