# Agent Note: Root Server Operation Fixtures

Status: implemented

## Problem

Ordinary root HTTP tests construct the complete Server and repeatedly register
all MCP tools and compile their schemas before exercising unrelated HTTP routes.
Their DAO-controlled fixtures also execute lower business rules to obtain fixed
results. This combines protocol, assembly and business failures, while some of
the same files own actual SDK, socket, gateway, file and shutdown mechanisms.
Removing application construction indiscriminately would erase those proofs.

## Decision

Production Server construction and ordinary HTTP fixtures share one private
HTTP router builder. Production `New` retains real authentication, all fourteen
MCP adapter groups, Session and Worker read-only construction, error propagation
and transport shutdown. It passes those real adapters and instance-owned
business outputs into the shared router. Ordinary HTTP fixtures supply strict
direct operations and controlled Identity results without constructing MCP tools.
The real parser, authentication protocol, encoder, route registration, Web and
health behavior remain in the common production path.

The required consumer contracts keep their existing method and result semantics.
Session exposes its existing sixty-member Operations table and archive resource
types through a route constructor, while its Service constructor retains real
origin binding and private default operation assembly. Token admission has a
narrow permit boundary; form parsing, verified-client charging and dispatch stay
real. Application output interfaces preserve every method required by HTTP, MCP
and transfer assembly, including shared attachment/lease instances. Worker and
resource owners keep their concrete lifecycle roles.

Fixtures preserve original inputs, complete states and wire assertions, with
separate immutable expected facts and independently supplied operation outcomes.
They do not infer persistence from proposed writes or later mock reads. Core and
Service receivers execute the original business and coordination guarantees
before the corresponding root lower-layer chains are removed. Exact inherited
owner selections and receiver costs are included in a fixed sequential proof
bundle rather than hidden behind root-package timing.

Complete MCP, provider gateway, configuration, runtime, TCP/WebSocket, retained
file/lease and shutdown tests retain the real mechanisms they observe. Full MCP
cases still use production modules, tool registration, schemas and SDK clients;
only their Application instance business outputs are controlled. Default binding
tests distinguish actual dependencies and two independent Applications, rather
than relying on function addresses. Tagged SQL/process/stress entries retain
their execution boundaries and data.

This supersedes the ordinary business-fixture boundary of the
[earlier root DAO decision](2026-11-09-root-http-test-dao-ownership.md). That decision
continues to explain the earlier removal of PostgreSQL setup and the distinction
between controlled transaction facts and physical mechanisms.

## Alternatives

**Construct the entire application for every HTTP case.** This repeats unrelated
MCP schema compilation and executes lower business decisions to obtain fixed
results. It remains necessary for actual default assembly and full MCP proofs.

**Build a separate test router or register only one production MCP tool.** This
can pass after production routes, adapters or the complete tool catalog break.
The shared HTTP builder and retained complete MCP construction preserve those
separate responsibilities.

**Replace real resources with supplied outcomes.** Returned errors or close
counts cannot prove socket delivery, consumed upstream responses, actual file
leases or transport users exiting before dependency release.

**Move upper workflows into storage tests.** Ordinary Root had no real Daynight
SQL observations to transfer. New SQL scenarios would add unrelated cost and
still put business and protocol responsibilities at the wrong layer.

## Consequences

Ordinary HTTP feedback avoids unrelated MCP registration while full assembly and
real protocol mechanisms keep their original cost and evidence. Explicit
consumer ports and instance outputs make dependency identity and result
propagation observable. Mutable model fields and raw inputs require independent
oracles so in-place mutations cannot also change their expected values.

Receiver and support-package execution remains part of obtaining the original
proof. Matched complete Root and full sequential-bundle measurements include
preparation, reset and final cleanup; nested construction spans are diagnostic
and are never added together. Neither local package nor sequential command gains
establish hosted parallel-CI savings. Cleanup errors, unfinished users, missing
original cases and unexecuted receiving owners prevent acceptance.
