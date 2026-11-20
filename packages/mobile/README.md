# Daynight Mobile

Daynight Mobile is a private React Native and TypeScript workspace for iOS and
Android. Expo Router owns the native tabs: My Work is the default screen, with
separate Projects and Assistants screens. The screens have local empty states;
the app does not connect to a Daynight service.

## Develop

Use the repository's Node.js 24 LTS and pnpm 11.28.6. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @codetreker/daynight-mobile start
```

Open the Metro URL with [Expo Go](https://expo.dev/go) on a device with support
for SDK 58. To launch a local simulator or emulator that has a compatible Expo
Go, run `pnpm --filter @codetreker/daynight-mobile start:ios` or use
`start:android`. The iOS simulator requires macOS and Xcode; the Android emulator
requires Android Studio and an emulator image. Refer to the
[Expo SDK compatibility table](https://docs.expo.dev/versions/latest/) for the
supported platform and build-tool versions.

To compile and install the app itself, run
`pnpm --filter @codetreker/daynight-mobile exec expo run:ios` or
`pnpm --filter @codetreker/daynight-mobile exec expo run:android` with the
corresponding native toolchain. Expo generates the `ios/` and `android/` projects
from `app.json`; they are not checked in. The shared `cc.daynight.mobile`
identifier is used for local development. No signing or store publishing is
configured.

## Verify

```bash
pnpm --filter @codetreker/daynight-mobile typecheck
CI=1 pnpm --filter @codetreker/daynight-mobile exec expo install --check
pnpm --filter @codetreker/daynight-mobile bundle
```

The `bundle` command writes Metro output for both platforms to `.tmp/bundles/`
under this package. It does not compile native code or verify device behavior.
The independent `verify (mobile)` CI job runs these checks when selected by the
[repository routing rules](../../README.md#ci-selection).
For a runtime smoke check, open the app on each platform, confirm it starts on
My Work, switch to Projects and Assistants, and return to My Work.
