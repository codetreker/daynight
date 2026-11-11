# Agent Note: Independent MCP and CLI Setup Paths

Status: implemented

## Problem

Visitors need to connect an Agent directly to a Daynight service as well as use
its CLI and Agent skill. A CLI-only guide does not explain client configuration,
authorization or how to distinguish a saved configuration from a working MCP
connection. The guide must remain publicly readable without exposing credentials
or depending on account and service requests.

## Decision

The public setup guide presents two always-expanded paths: MCP first, then the
existing five CLI and Agent skill steps. MCP gives Codex, Claude Code and Copilot
CLI user-level configuration, OAuth guidance and a read-only `team_list` request
for verifying a connection. Commands use POSIX shell quoting, with Git Bash
guidance for Windows. It links to the existing installation manual and account
authorization management. The page derives `/mcp` from the browser's
current origin without discovery or API calls; the CLI's default service remains
independent. Client selection is page-local, and all command blocks share one
copy lifecycle. The [Web requirements](../../../../docs/spec/daynight-web.md#日常使用引导)
own observable behavior and the [Web design](../../../../docs/design/daynight-web.md#日常使用引导页)
owns composition.

The [public guide decision](../../archived/architecture/2026-10-26-public-setup-guide.md)
records the public entry and zero-request boundary; the [original guide decision](../../archived/feature/2026-10-25-web-setup-guide.md)
records the five-step CLI guide and its original handling of credentials. This
extends its content while retaining those public and CLI boundaries.

## Alternatives

**Place MCP after the CLI steps.** This suggests that MCP requires CLI installation
and makes the independent connection path harder to discover.

**Use top-level tabs.** Tabs hide one path and introduce navigation state when
both paths are useful for reference; expanded sections retain the existing guide's
reading model.

**Provide one generic JSON configuration.** Clients use different configuration
formats and authorization interactions. Client-specific commands preserve their
actual contracts while the endpoint and installation manual serve other HTTP
clients.

## Consequences

Users can follow either path without account data or credentials entering the
page. The browser origin assumes the supported same-origin deployment; aliases
outside that model are not resolved through discovery. The guide cannot prove an
MCP connection itself: successful read-only tool invocation remains the user's
verification. Client commands and documentation links must remain synchronized
with their respective clients, and additional clients need their own configuration
and authorization instructions.
