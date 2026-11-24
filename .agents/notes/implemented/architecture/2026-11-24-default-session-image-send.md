# Agent Note: Default ordinary Session image send

Status: implemented

## Problem

The image qualification registry tied ordinary sends to exact native binaries,
routes, and models. Linux lacked a matching Codex runtime profile, and a native
upgrade invalidated the macOS records even when the new executable could still
send images. The product prevented these Sessions from attempting ordinary image
input before the native adapter could handle it.

## Decision

Codex and Copilot use the Daynight image input limits by default for ordinary
send in an established Session with a confirmed current model. An explicit
unsupported model result or a tighter valid input limit already available from
the adapter still controls the operation. Send uses the existing native input
path and bound authorization. The current model, turn, settings, and operation
are checked before native dispatch. Image steer has its own existing evidence
requirements.

The [previous qualification policy](2026-11-16-image-qualification-boundaries.md)
continues to explain the evidence and original-byte guarantees. The
[Codex configuration observation](2026-11-16-codex-image-config-observation.md),
[macOS runtime evidence](2026-11-19-codex-macos-image-runtime.md), and
[Copilot runtime observation](2026-11-16-copilot-image-runtime-observation.md)
describe the sources of narrower native facts.

## Alternatives

**Keep expanding the exact registry.** A verified row can enable a particular
installation. Every changed executable or route requires a new row before users
can send again.

**Add a new capability probe.** Runtime declarations can identify some native
limitations. They do not prove that the selected route passes every image to the
model. Adding more observations before ordinary send would also delay access on
providers without equivalent capability fields.

## Consequences

An unsupported combination that the existing catalog cannot identify can now
reach the native sender. Explicit native failure and uncertain dispatch retain
their existing receipt and draft behavior. The default makes no claim about model
recognition or platform acceptance. Those outcomes are recorded from the actual
[product and native verification](../../../../docs/spec/session-image-acceptance.md).
