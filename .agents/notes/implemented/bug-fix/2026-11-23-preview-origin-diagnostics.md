# Agent Note: Preview Origin Configuration Diagnostics

Status: implemented

## Problem

A combined main/preview hostname rejection always identifies preview_origin.
When only the main hostname is invalid, the configuration loader consequently
reports the valid preview value's source. The generic hostname message also
leaves local operators without the DNS naming rules needed to correct it.

## Decision

Preview configuration validates each DNS hostname independently after the
existing numeric loopback HTTP fixture exception. It checks the main hostname
first and identifies public_origin or preview_origin accordingly. The existing
loader adds the server prefix, validation phase and actual field source.
Rules describe lowercase dotted DNS names and exclude IP addresses, single-label
names and trailing dots without reflecting configured values. Equal valid DNS
hostnames retain preview_origin attribution and explain that different ports
cannot isolate preview Cookies.

The [authentication design](../../../../docs/design/daynight-auth.md#显式浏览器预览-sso)
owns origin isolation. The [layered configuration decision](../architecture/2026-11-11-server-layered-configuration.md)
owns source decoration. The [local deployment guide](../../../../deployment/localhost/README.md)
provides explicit HTTP settings, exact callback registration, wildcard resolution
and coordinated origin/port changes.

## Alternatives

**Retain the combined hostname rejection.** Its preview field selects the wrong
source when the main hostname alone violates the rule, even with a valid callback.

**Admit a single localhost hostname for browser previews.** This changes the
isolation policy and cannot provide Task/Goal preview subdomains. Distinct local
DNS names already satisfy the browser requirement with the explicit HTTP setting.

## Consequences

Operators receive a correction tied to the actual failing configuration source.
Admission, generic logging error codes, routing and authentication remain unchanged.
Source-provenance tests execute the real loader with matching callbacks; pure
validation tests retain numeric IPv4/IPv6 fixture and existing isolation coverage.
Startup validates syntax and relationships without checking DNS or TLS, so local
operators still need to verify browser resolution independently.
