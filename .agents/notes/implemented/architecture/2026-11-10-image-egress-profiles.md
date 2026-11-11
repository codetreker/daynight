# Agent Note: Deployment profiles identify protected image destinations

Status: implemented

## Problem

A numerically public IP can still identify a Controller host, an internal
public-address subnet, or a destination translated into a protected service.
Checking DNS answers and the connected socket peer cannot identify those
deployment-specific targets by itself. Conversely, requiring proof of every
Internet forwarding hop or every remote site's backend would prevent useful
capture without establishing a meaningful local security boundary.

The [source decision](2026-11-05-session-image-sources.md) required a trusted
egress check but initially provided only its consumer. Its conservative refusal
kept unsupported deployments closed; it did not provide a production policy
source or establish that a separate egress service was necessary.

## Decision

The protected boundary is the Controller's trusted OS and deployment. The
existing credential-free HTTP transport checks special-use addresses, all DNS
answers, every redirect and the selected socket peer. A local deployment profile
adds current host addresses and interface networks, additional protected CIDRs
and domain suffixes, and the facts needed to handle destination translation.
IPv4, IPv6 and their mapped representations share this destination policy.

The profile belongs to `controller.externalImages` in the existing local
`config.yml`. Its source has the same operator trust boundary as the Controller's
local configuration; message text and task input cannot select or construct it.
The parser bounds input and strictly validates the owned section without
changing unrelated configuration. Errors do not expose configuration values.

An operator declares the complete additional protected destinations and one of
two existing egress conditions. A direct profile lists all known NAT64 prefixes
and declares that other destination translation or transparent forwarding does
not cross the protected boundary. An enforced profile names an existing policy
that blocks the protected set after translation. Known translation prefixes are
rejected conservatively. These declarations describe real deployment facts;
neither an arbitrary identifier nor a successful public request verifies them.
The feature does not configure a firewall, proxy, gateway or new service.

Every attempt binds one profile generation. Its revision derives from canonical
profile content, so changing a field cannot retain permission through an
unchanged operator-supplied version. Current host interfaces and the configured
boundary are checked throughout capture. Unknown state or a change invalidates
the old generation and cancels its sockets. A replacement profile cannot restart
an interrupted attempt. Daynight execution and publication fences remain
independent, including while transferring an already acquired immutable copy.

The threat boundary does not include discovering remote public services' private
backends. Ordinary outbound source NAT does not by itself violate it. A mapping
of an approved destination into this deployment's protected targets does.
The [source design](../../../../docs/design/session-image-sources.md) owns the
configuration fields, destination checks and acquisition lifecycle.

## Alternatives

**Treat all non-special-use addresses as external.** A host's own public address
and internally used public subnets defeat that classification while preserving
socket-peer equality. Local interfaces and deployment-specific destinations
must participate in the decision.

**Require a new global network-proof service.** The Controller needs facts about
its protected boundary, not a proof of the Internet. Local trusted declarations
and an existing enforcement boundary can supply those facts without a new RPC
or credential-bearing proxy. The operator still must know the declared facts.

**Enable capture from a public canary or a boolean flag.** A successful request
does not identify protected aliases, translation prefixes or internal routes.
Explicit destination sets and a declared boundary are reviewable; a reachability
result cannot replace them.

**Automatically install a firewall or restrict sources to a fixed image host.**
Those approaches change the user's network or the confirmed HTTP(S) scope.
Neither is required to consume a deployment's existing protected boundary.

## Consequences

Configured deployments have a production policy source, while absent, malformed
or changed profiles fail closed. Operator declarations remain part of the trust
model and require deployment-specific verification. Controlled transport tests
do not establish those facts for an unconfigured real host.

The profile is intentionally separate from native local-file Read authority and
Daynight access control. It cannot grant local filesystem permission, revive a
revoked Session or refresh historical bytes. Maintaining the protected sets and
egress declaration is an operator responsibility when the network changes.

Per-admission observations and active polling bound application waiting without
claiming atomic network-change notification. Configuration belongs on a trusted
local regular filesystem. Node cannot forcibly join a permanently stalled kernel
read: a timed-out observation revokes network activity, keeps at most one read
outstanding, and closes its file handle when the operation eventually returns.
It never adopts that late result or accumulates replacement reads.
