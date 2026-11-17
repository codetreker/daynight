# Agent Note: Public Markdown Image Integration

Status: implemented

## Problem

Controlled HTTP fixtures can prove DNS, redirect, peer and credential guards.
They cannot prove that the production Markdown source and capture components
save a public HTTP or HTTPS response in the Go service, or that the service
serves the same original after the source and Controller become unavailable.
An arbitrary egress profile identifier also cannot establish the deployment
facts needed to admit those source requests.

## Decision

The Markdown source module owns a separate, repeatable integration regression
for public HTTP and HTTPS image capture, service persistence and immutable
history. Its [workflow](../../../../.github/workflows/external-image-acceptance.yml)
runs on changes to this regression and its direct source/capture owners, or by
manual dispatch. Public-network dependencies stay outside ordinary unit tests
and the product E2E suite. The [development guide](../../../../docs/development.md#public-markdown-image-integration)
owns commands and evidence locations.

The regression builds current source, uses real Go and PostgreSQL, and connects
the production Controller source, ledger and relay components. Complete Markdown
input and the external identity provider are controlled test inputs. Public DNS,
HTTP bytes, HTTPS certificate validation, image decoding, Go persistence and
subsequent resource reads are real. This is a source integration regression;
it does not assert native-model vision or complete browser behavior.
The decoder wrapper forwards the runtime's arguments to the server so that it
uses the isolated configuration root as well as the configured image helper.

Network setup is restricted to a fresh standard GitHub-hosted Linux VM. A
Controller namespace has one owned route to the host. A job-owned nftables
policy checks final destinations in both INPUT and FORWARD, after destination
NAT. Necessary service and DNS exceptions must match original and final
addresses, protocol and port. The policy refuses every other destination except
the selected public image addresses. A second namespace and temporary receiver
verify translated-target rejection without contacting external private targets.
IPv6 is disabled and observed in the namespaces. The regression records actual
host, Docker and namespace networks, rules, counters and cleanup results under
its temporary run directory.

The operator declaration follows the existing [egress profile decision](../architecture/2026-11-10-image-egress-profiles.md).
Its policy identity contains the digest of installed stateless rules. The
regression rechecks that digest before namespace execution and source shutdown.
A separate earlier deny rule blocks source connections after capture, retaining
the original protection policy. Each denied HTTP/HTTPS probe uses the captured
peer and requires an increase in its protocol's actual deny counter; DNS or
unrelated origin failure cannot establish source shutdown. The resource and
hash must remain unchanged through source denial and Controller shutdown.

GitHub documents standard non-single-CPU hosted runners as fresh VMs with
administrative access. Eligible Linux jobs can use either AWS or Azure; an
Ubuntu label does not identify a cloud. The supported platform's ordinary IPv4
egress model supplies the outer trust boundary, while local rules and assets
are read from the actual job. No claim is made about a user's production
network. See [GitHub runner hosting](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners),
[Azure outbound connections](https://learn.microsoft.com/en-us/azure/load-balancer/load-balancer-outbound-connections)
and [AWS NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html).

## Alternatives

**Use only loopback fixtures.** They remain the owner of the detailed transport
failure matrix, but do not exercise public origin access or real service
persistence. Calling them public-network acceptance would overstate their
evidence.

**Use the developer's current network.** Its shared gateways, private targets
and translation policy are not created by this regression. Automating changes
there would affect unrelated resources and still leave unobserved deployment
facts. The script therefore rejects ordinary local execution.

**Create a general acceptance platform or public fixture service.** Those add
service ownership, credentials and ongoing resource costs beyond Markdown
source persistence. The regression instead uses fixed read-only public images
and blocks its own access to the origin. It cannot change a third-party site's
content; same-URL content replacement remains separately controlled coverage.

## Consequences

Real public-network availability can fail this independent job. DNS changes
outside the frozen admitted set fail closed; a green controlled suite cannot
replace a failed integration result. Setup, execution and cleanup are bounded,
and an independent workflow cleanup step reconciles owned resources after
failure or cancellation. Cleanup cannot turn a failed test into success.
Linux pidfds bind signals and exit observations to the original processes.
Unconfirmed process exit retains namespace names and guards for retry instead
of reporting successful cleanup after unlinking a still-referenced namespace.

The included guarantees are real source-to-service bytes, immutable resource
identity, original/final destination admission and attributable cleanup. Native
model output, browser rendering, IPv6 public capture and other cloud/network
topologies are outside this regression. Adding such cases later requires their
own observed deployment and behavior, not relaxing this script's hosted-VM
gate or importing a production profile. The product guard and its general
deployment contract remain unchanged.
