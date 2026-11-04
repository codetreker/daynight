# Agent Note: Language Selector Spacing

Status: implemented

## Problem

The shared language selector consumes header space with a repeated visible label,
while browser-drawn arrows can sit against the right border. Narrow and graph
styles also override the selector padding, leaving too little room for its text
and arrow.

## Decision

The native select retains the bilingual accessible name without a visible label.
Its shared styling reserves space for both language names and draws a pointer-free
arrow at a fixed inset, including in forced-colors mode. Entry-specific rules
retain the shared horizontal spacing. The [locale runtime decision](../architecture/2026-10-22-web-locale-runtime.md)
continues to own preference and synchronization behavior.

## Alternatives

**Keep the browser-drawn arrow.** Its placement depends on the browser and is not
controlled by padding alone, so it cannot reliably maintain the required inset.

**Replace the select with a custom menu.** This would require rebuilding keyboard,
focus and accessibility behavior that the native control already provides.

## Consequences

The selector keeps its native interaction and shared preference behavior while
using consistent arrow geometry across entry points. The drawn arrow and text
space must be checked together when styling or language names change.
