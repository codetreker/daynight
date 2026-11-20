# Agent Note: Fixed external-image transport TLS fixtures

Status: implemented

## Problem

The external-image transport tests prepared self-signed certificates with an
OpenSSL subprocess for every case. Windows main checks run
[44743383163](https://github.com/codetreker/daynight/actions/runs/44743383163/job/136313286291)
failed while preparing the first certificate, before the OAuth listeners or
requests started. The recorded failure did not retain the subprocess exit,
signal or stderr, so it does not establish a timeout or a product TLS defect.
Certificate provisioning adds an executable dependency and process scheduling
cost to tests whose subject is verified transport and authentication.

## Decision

The [transport tests](../../../../packages/daynight/test/scripts/external-image-auth.test.ts)
load three committed EC P-256 certificate/key pairs from
`packages/daynight/test/fixtures/external-image-auth/`. Each certificate is a
self-signed CA with a SHA-256 signature. The trusted and untrusted app identities
cover `app.daynight.localhost` and `preview.daynight.localhost`; the provider
identity covers `github.com`. The untrusted app has an independent key and root.
Each case retains its own temporary directory and copies its trust material
there for curl and the separate Node reader.

These private keys are deliberately public test data. They are used only by
loopback listeners and must never establish trust in a product or deployment.
Certificates are valid from 2020-01-01 through 2120-01-01 UTC. The tests check
current validity, CA status, self-signature, hostnames and key matching, while
real successful and rejected TLS handshakes preserve the trust-boundary proof.
Replacement materials must retain all three identities, independent trust
roots, matching keys and validity covering supported CI/development dates.

## Alternatives

**Keep runtime OpenSSL and increase its deadline.** The failure did not prove
that the deadline caused it. More waiting would retain process provisioning and
the external executable as unrelated prerequisites for transport coverage.

**Generate certificates through a new JavaScript dependency.** This would remove
the executable lookup but add dependency ownership and repeat key generation
without exercising behavior owned by these tests. Fixed materials preserve
real certificate parsing and TLS verification without runtime generation.

## Consequences

Certificate preparation is a local file operation on every supported platform.
The tests still exercise the complete controlled OAuth/SSO sequence, Secure
cookies, token/session assertions, verified HTTP/WebSocket forwarding and
rejection of the independent untrusted root. Production TLS/OAuth code and
dependencies are unchanged. The fixed validity interval makes certificate
replacement a maintenance responsibility; validity assertions expose expiration
or an unsupported system clock directly.
