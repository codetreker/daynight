# Agent Note: Ubuntu Network Diagnostics

Status: implemented

## Problem

Ubuntu package preparation can fail before shell or browser tests start. An
APT domain-resolution error alone does not distinguish the host resolver,
the package sandbox, a proxy, or the upstream service. Repeated failures across
runner regions can leave the same ambiguity without producing test artifacts.

## Decision

The shell-completion and Web browser jobs capture bounded, read-only network
observations immediately before package installation and again when that
installation fails. The first artifact is published before installation starts;
the failure artifact has its own upload condition, independent of whether a
business test ran.

The collector uses fixed public Ubuntu package hosts and a Microsoft package
host as a comparison. DNS observations compare the runner user, root, and the
APT sandbox user. Direct HTTPS observations remain separate from APT transport
downloads of an official InRelease file under the runner and root identities.
These temporary downloads do not update system lists, install packages, verify
repository signatures, or establish that package installation succeeds. Their
contents are discarded after the observation.

Only selected host resolver information, bounded APT settings, and proxy-presence
flags are recorded; credentials and environment values are excluded. Individual
probe failures are observations, not successful package preparation. Collector
or output failures remain errors.

The existing package installation commands, signed sources, dependency sets,
locked browser, job deadlines, tests, and required gates remain authoritative.
No resolver, source, firewall, or package configuration is changed by a probe.
The earlier [official-archive decision](../../archived/testing/2026-10-22-ubuntu-package-mirrors.md)
records why mirror preference was changed; it does not establish a remedy for a
failure resolving the official services themselves.

## Alternatives

**Change DNS servers or pin archive IP addresses immediately.** The original
logs do not identify which resolver path failed. Such a change would add new
network configuration ownership without evidence that it addresses the fault.

**Remove host dependencies or use a different browser.** This would change the
verification environment before establishing that its packages are unnecessary.
Browser-only Product E2E preparation has its own
[decision](2026-11-10-product-e2e-browser-installation.md); it does not establish
the font and layout requirements of the Web module's browser suite.

**Repeat unchanged jobs.** Further attempts do not add the missing host and
transport observations and can consume the same preparation window.

## Consequences

Installation failures retain diagnostic evidence even when all downstream tests
are skipped. Probe and upload steps consume part of the existing job budget;
their own bounds keep them from occupying an unbounded interval. A successful
probe is only a point-in-time observation and cannot replace actual APT
installation or the selected tests. The evidence supports a subsequent repair
without implying that diagnostics alone restore package access.
