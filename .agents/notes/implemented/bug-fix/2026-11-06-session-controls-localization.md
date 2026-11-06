# Agent Note: Localized Session Control Descriptions

Status: implemented

## Problem

The Chinese Session settings panel renders Controller-authored English labels,
permission choices and explanations. These descriptions explain distinct native
permission policies, so the surrounding translated panel is insufficient for
understanding a selection. Built-in command descriptions have the same issue.
Provider model names and skill descriptions must remain recognizable.

## Decision

The Web Session message catalog owns English and Chinese presentation for known
Provider/setting IDs and their built-in option values. The panel applies those
messages to labels, explanations and confirmed-value notices without changing
the underlying catalog, selected value or operation. Native model and effort
labels remain intact; Claude's Controller-authored native-default option is
localized. Unknown settings and values retain their original text.

Command descriptions are localized at rendering, outside command selection,
catalog signatures and dispatch. Known built-in command identities and exact
Controller placeholder text identify translatable descriptions. Other native
descriptions, names and argument hints remain unchanged. The protocol is
unchanged, so existing Controllers remain usable.

The [Session requirements](../../../../docs/spec/task-sessions.md#chatbox-设置命令与运行状态)
own the behavior. The [English operation-label decision](../../archived/bug-fix/2026-11-04-english-session-operation-labels.md)
continues to govern the fixed English toolbar and activity positions.

## Alternatives

**Add description provenance to the protocol.** This would distinguish a real
skill description identical to a placeholder. Both TypeScript and Go currently
validate exact command fields, so adding a field requires coordinated protocol
compatibility and rollout. Render-time matching provides the requested
localization without that deployment dependency.

**Translate the received controls object.** This would couple locale changes to
catalog equality and command-selection reset logic. Rendering localized text
from the unchanged object avoids introducing operation state transitions.

## Consequences

Open panels and menus update with locale while retaining drafts, pending
intents, command selection and native confirmation semantics. New settings or
options remain readable before the Web catalog knows them. New built-in copy
requires maintaining the catalog alongside its Controller owner.

The existing wire format cannot distinguish a native description exactly equal
to a Controller placeholder from the placeholder itself. Within the recognized
command family, that identical text receives the same translation. Arbitrary
native descriptions are not translated. A future requirement for lossless
description provenance must add an explicitly compatible protocol mechanism.
