# Agent Note: Account Credential Last Use

Status: implemented

## Problem

Account owners need to recognize recently used credentials without treating
an approximate recorded event as an audit log. Updating auxiliary metadata must
not disrupt credential management or conceal protocol and identity failures.

## Decision

The account credentials page displays the recorded PAT and OAuth grant use time
with a shared local display clock. A null value means no usage was recorded;
a recorded value offers an approximate relative label and the full local time.
The page reads the required PAT field and OAuth v2 representation described by
the [HTTP metadata decision](../architecture/2026-11-12-credential-usage-http.md).
Same-ID list and expiry receipts merge the latest recorded value without replacing
the expiry observation or interaction state. The [authentication design](../../../../docs/design/daynight-auth.md#主站-session-与-pat)
owns the interface and state rules.

## Alternatives

**Poll each credential for a live value.** Repeated requests add load and change
network admission while the recorded event is already approximate. A single local
clock updates labels; existing reads obtain newer metadata.

**Replace the displayed value with each receipt.** Concurrent reads and expiry
receipts can arrive out of order and move a displayed usage time backwards. A
same-ID maximum preserves the latest observed time without transferring it to a
new credential.

## Consequences

Owners can inspect a readable local time across input methods without resetting
management state. The display is approximate and does not guarantee a current
server read; no historical usage is inferred from null. New clients require the
protocol-capable backend and recovery artifact specified by the HTTP decision.
