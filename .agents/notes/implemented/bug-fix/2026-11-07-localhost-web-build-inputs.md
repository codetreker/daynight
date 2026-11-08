# Agent Note: Localhost Web build inputs

Status: implemented

## Problem

The localhost image cannot complete its Web stage when TypeScript reaches
acceptance scripts that depend on omitted server test fixtures. A second source
gap appears when a shared CLI API imports a new Task status module outside the
Dockerfile's individually copied directories. Successful compilation in a full
workspace does not establish that the filtered Docker context is complete.

## Decision

Production compilation uses `tsconfig.build.json`, which inherits the strict
compiler options from `tsconfig.json` and selects application sources and the
Vite configuration. TypeScript follows their imports. Full `web:typecheck`
continues to check application sources, tests, scripts and tool configurations
in the complete workspace.

The Docker context and Web stage include the complete CLI source tree. Shared
API, Thread, Session and Task protocol imports can follow their dependencies
without maintaining a second directory-level dependency list. Only reachable
production sources are typechecked; Vite bundles the browser import graph. Host
dependencies, generated assets, scratch directories and test files retain their
Docker exclusions.

The Web quality runner performs full typechecking, tooling tests, the actual
localhost Dockerfile's `web` target, coverage collection and statement checking.
The Docker stage verifies locked container installation, production compilation
and publication into the Go embed directory without starting services or
running Go tests. The existing module selection and independent browser job
remain unchanged. The [Web validation decision](../testing/2026-11-06-web-quality-validation.md)
owns subprocess limits and the enclosing quality budget.

## Alternatives

**Copy server acceptance fixtures into the Web stage.** This makes production
compilation depend on other modules' test tooling and retains the need to copy
each fixture's future imports.

**Add each missing shared CLI directory.** Adding `task/` fixes the current
import, but every new transitive dependency requires synchronized Docker COPY
and context-filter changes.

**Validate only the host Web build.** The complete workspace contains files
that the Docker context or stage can omit, so this check cannot detect the
reported deployment failure.

## Consequences

Production compilation requires its real source graph and no acceptance
fixture. Full-workspace typechecking remains a mandatory quality stage, so
test and tooling type errors still fail validation.

The build context includes more CLI source files, and edits to that tree can
invalidate the Web source layer. Dependency installation remains separately
cached. Unused CLI source is neither bundled into Web assets nor copied into
the final runtime image.

Quality validation requires Docker and registry access and spends additional
time on container compilation. It leaves build cache but creates no running
service, database or image tag. The Web target cannot establish final Go image
startup; disposable deployment validation has that separate responsibility.
