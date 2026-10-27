# Agent Note: Ignore Unknown Configuration Fields

Status: implemented

## Problem

A shared CLI configuration can contain settings a particular installed version
does not recognize. Rejecting an unknown key prevents otherwise valid service,
review and worker commands from reading the settings they own.

## Decision

Configuration readers ignore unknown fields at the root, in `review` and
`worker`, and in their repository entries. Each projection constructs its runtime
configuration from known fields. The original YAML document retains unknown
nodes, so targeted configuration writes preserve their values and comments.

YAML syntax, duplicate keys, decoding failures and required mapping structures
remain validated. Known fields retain their existing type, range, identity and
path checks. An unknown key does not suppress validation of a known sibling.

This policy replaces the unknown-key rejection in the
[review configuration section decision](../architecture/2026-10-27-review-configuration-section.md).
Review settings still belong under `review`; old flat settings are ignored and
must be moved explicitly to become effective. No alternate layout is read.

## Alternatives

**Retain unknown-key rejection.** This catches misspellings early, but a setting
that the current version cannot consume blocks unrelated valid commands.

**Allow unknown root fields only.** This removes the shared-parser failure but
leaves review and worker commands failing on unknown section or repository keys.
The same field policy applies at each configuration mapping they consume.

**Delete unknown fields when parsing or saving.** Filtering the YAML would lose
settings that another consumer needs. Explicit runtime projections already avoid
using unknown data without changing its stored representation.

## Consequences

Commands can share a configuration with unrecognized extensions. Configuration
edits preserve unrelated data and retain the existing lock, atomic replacement
and alias safeguards. Invalid YAML remains a document failure even when it
appears within an unknown field.

Misspelled optional keys are ignored and the corresponding omitted known field
uses its documented default. Misspelled required keys still leave the required
field missing. Diagnostics for recognized invalid values remain available.
