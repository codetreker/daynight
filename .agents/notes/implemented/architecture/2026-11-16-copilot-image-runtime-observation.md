# Agent Note: Copilot image identity uses private runtime observations

Status: implemented

## Problem

An exact image qualification cannot match a running native process when its
executable or selected backend is unknown. A model catalog supplies neither
identity. Copilot's endpoint RPC describes the current Session configuration,
but its response also contains credentials that must not become Controller state,
diagnostics or qualification identifiers. A model switch can invalidate a useful
observation before the asynchronous image preparation finishes.

## Decision

The [Provider design](../../../../docs/design/session-image-providers.md) separates
runtime observation from the
[qualification decision](2026-11-16-image-qualification-boundaries.md). Copilot
observes the native-declared current model and endpoint through a dedicated
private bridge operation. The bridge projects only explicitly supported route
fields before returning a digest. Credentials, arbitrary headers and raw endpoint
responses do not leave that operation, including its failure paths. Unknown
protocol values or unsafe endpoint representations produce no observation.

The owned native process receives `COPILOT_ALLOW_GET_PROVIDER_ENDPOINT=true`
only when its runtime has an image media owner and the caller has not supplied
the variable. Copilot 1.0.105 gates this read on the exact string `true`.
Explicit values, including empty strings and disabling values, remain untouched;
Windows recognizes their environment names without regard to case. The default
belongs to the cloned child environment, not the caller, SDK bridge or system.
It grants endpoint observation, not different model, routing or authentication
behavior; a refused read still closes image admission.

The SDK permits an absent `transport` declaration. Its digest records that
absence as `null`, distinct from both explicit HTTP and WebSocket declarations.
Existing explicit-transport digests retain their values. A supplied null,
non-string or unknown transport is invalid rather than an absent declaration.

The executable digest comes from the verified launch artifact for the same owned
Windows native process. A JavaScript launcher, interpreter, materialized runtime
or unverified fallback does not acquire a native executable identity from its
filename or version string. Process closure invalidates the observation.

Session and execution ownership, the current model and an observation generation
bind asynchronous preparation and final dispatch. Model or settings changes,
resume and connection loss invalidate the old observation. The generation is a
runtime fence rather than part of the stable qualification digest: rereading an
unchanged declaration must not create a different qualification identity.

The endpoint digest identifies the native-declared visible route configuration.
It does not prove the final HTTP destination, a hidden backend deployment, model
weights or an internal image-processing algorithm. Observation alone does not
grant qualification; the production registry has no Copilot row until the exact
combination has its required input, receipt, history and product evidence.

## Alternatives

**Derive identity from version strings, model names or the SDK process field.**
Version strings do not identify a binary, and a model name does not select a
backend. The SDK connects to an externally owned native process, so its private
process field is not the launch authority.

**Return the complete endpoint response through generic RPC.** This exposes
credentials to another process and makes accidental logging or hashing possible.
A dedicated projection limits both the successful result and failure reporting.

**Use every observation generation as qualification identity.** This would revoke
an unchanged qualification on each read. Stable declared identity and transient
dispatch ownership require separate values.

**Assume an omitted transport means HTTP.** The endpoint declaration does not
establish that default. Keeping a separate undeclared value allows an exact
qualification to state the observation it covers without inventing transport
evidence.

**Enable endpoint reads for every Copilot process or replace explicit settings.**
Text-only runtimes do not need this read. Replacing caller-supplied values would
override native policy rather than applying a scoped default.

**Install a production request handler to observe every native request.** The
SDK buffers the entire request before its custom handler runs, and its default
forwarding can follow redirects. Such a handler would require a separate resource
and forwarding contract; it is not needed to report a clearly bounded native
declaration. Actual request evidence must not be inferred from this observation.

## Consequences

Supported runtime observations can supply missing fields to the existing exact
selector without extending public DTOs or persistent schemas. Other platforms
and launcher forms remain unknown rather than borrowing the Windows evidence.
The additional native reads may fail or race with settings changes; failure
closes image admission while preserving ordinary text behavior and existing
accepted input facts.

The observation cannot justify a profile entry by itself. A later qualification
must state the visible identity and conditions its evidence actually establishes.
Native acceptance followed by a delivery failure remains an accepted or unknown
operation with retained originals; no observer failure authorizes resubmission.
