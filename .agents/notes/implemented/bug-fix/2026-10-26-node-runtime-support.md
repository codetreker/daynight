# Agent Note: CLI Node.js Runtime Support

Status: implemented

## Problem

Restricting the CLI to a single Node.js major rejects installation on working
Node.js 22 LTS and newer runtimes. The installation contract needs to permit
these runtimes while keeping source-development tools independently reproducible.

## Decision

The workspace manifests declare Node.js `>=22`, without a major-version ceiling.
The published CLI is emitted JavaScript; source development, native application
tests and publication retain Node.js 24 and pnpm 11.28.6. This partially
supersedes the runtime restriction established with the
[TypeScript CLI toolchain](../process/2026-10-16-typescript-cli-toolchain.md),
while preserving its build and validation decisions.

Installation guidance recommends the current patch of Node.js 22 or newer.
Production dependencies retain their existing versions. SQLite uses bundled
Node-API 10 binaries, which require Node.js 22.14.0 or newer; the broad package
engine does not establish support for earlier Node.js 22 patches. The
[Node-API version matrix](https://nodejs.org/api/n-api.html#node-api-version-matrix)
and [upstream crash report](https://github.com/WiseLibs/better-sqlite3/issues/1514)
describe the native binary requirement.

Native Linux validation packs the built CLI once. A separate Linux CI matrix
installs that tarball into fresh npm consumers using `--engine-strict` on Node.js
22.14.0, the latest 22 and 24 releases, and the current Node.js release. Its
JavaScript probe checks both launchers, command loading, executable discovery,
lossless API versions, native SQLite persistence and ESM select/checkbox prompts.
The final checks gate includes this matrix. Runtime installation instructions and
both website languages use the same Node.js major requirement.

## Alternatives

**Use SQLite 12 to cover Node.js 22.0.0.** Its ABI prebuilds work on early Node.js
22, but require installation scripts, which supported npm 12 environments can
block. It also declares an engine upper bound at Node.js 26. Replacing bundled
binaries with installation hooks would add installation failures for users of
current Node.js and npm.

**Ship two SQLite dependencies selected by Node-API version.** This can retain
bundled binaries on current Node.js while using SQLite 12 for early patches.
It adds an optional native dependency, installation work and a maintained runtime
selection module solely for outdated minor releases. Requiring the current patch
keeps installation and persistence on the existing implementation.

**Move the development toolchain to Node.js 22.** pnpm and directly executed
TypeScript scripts have later minor-version requirements. Published users run
compiled JavaScript and do not need these tools. Installed-artifact validation
keeps the consumer requirement independent of build-only dependencies.

## Consequences

Current Node.js 22 LTS users can install the CLI without engine overrides, and
newer majors are not rejected solely by the application's upper bound. Earlier
Node.js 22 patches must be updated before SQLite operations can work. The
compatibility matrix verifies concrete versions rather than proving every future
Node.js release. Native macOS and Windows application suites continue on Node.js
24, with their existing dependency and installation behavior.
