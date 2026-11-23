# Agent Note: Shared Expo Workspace for Mobile

Status: implemented

## Problem

Daynight needs a mobile application foundation for iOS and Android without
maintaining two sets of application code or coupling mobile development to the
browser workspace. The foundation must be usable while the mobile workflows
and service integration are still being defined.

## Decision

The [mobile package](../../../../packages/mobile/README.md) uses React Native,
Expo and TypeScript within the existing pnpm workspace. Expo generates local
native projects from the shared app configuration. Expo Router owns the native
tab navigation; My Work, Projects and Assistants are independent screens.

## Alternatives

**Manage native projects directly.** Committing Xcode and Gradle projects would
make native customization explicit, but would also make the repository maintain
platform build files before the application needs any native customizations.

**Reuse the Web workspace inside the application.** That would reuse existing
browser screens, but bind mobile navigation and rendering to the Web app. The
mobile package needs its own native entry points and can be verified without a
running service.

## Consequences

The application has one source tree and uses the platform's tab controls.
The Expo SDK constrains compatible versions of React, React Native and installed
native modules, independently of the Web package. Expo brings the React
Compiler into the workspace, where the Web Vite plugin can resolve its optional
peer. A pnpm package extension declares the missing Babel types imported by the
compiler's declarations so Web type-checks without enabling the compiler.
Metro can export both bundles without simulators; native compilation and
runtime validation still require the corresponding platform environments.
Authentication, data and notifications are outside this workspace's current
behavior.
