# Building Geodesic Notes for Android

The native `android/` directory is **generated**, not committed. It is produced
from `app.json` by `expo prebuild`. Committing it silently breaks continuous
native generation: `app.json` edits stop taking effect, because prebuild will
not overwrite an existing directory without `--clean`.

## Prerequisites

On Fedora, run the setup script — it installs exactly the SDK pieces this
project pins and nothing more:

```bash
./scripts/setup-fedora.sh
exec $SHELL          # pick up ANDROID_HOME / JAVA_HOME
```

Manually, the requirements are:

| Component   | Version        | Why |
|-------------|----------------|-----|
| JDK         | 17             | RN 0.81 + AGP 8.x. Fedora's default 21 also works. |
| Android API | 35             | `compileSdk` and `targetSdk` |
| min API     | 24             | Android 7.0 |
| Build tools | 35.0.0         | |
| NDK         | 27.1.12297006  | Must match exactly, or every native module rebuilds from source |
| CMake       | 3.22.1         | Skia and Reanimated |
| Gradle      | 8.14.3         | Fetched by the wrapper; do not install it |

These come from `expo-modules-autolinking`'s `ExpoRootProjectPlugin.kt`, not
from guesswork. If you bump the Expo SDK, re-read them there.

### Fedora-specific notes

- **Do not `dnf install gradle`.** The wrapper (`./gradlew`) fetches the exact
  version. A system Gradle on `PATH` is a common source of confusing failures.
- Some SDK binaries are still 32-bit ELF, so `libstdc++.i686`, `zlib.i686` and
  `ncurses-libs.i686` are installed.
- `adb` comes from the `android-tools` package.
- USB debugging needs a udev rule or `adb devices` reports `no permissions`.
  The script writes one for Samsung (`04e8`); run `lsusb` and add your vendor
  id if your device is something else.
- SELinux does not need changing for this.

## Debug APK

```bash
cd frontend
npm install
npx expo prebuild --platform android --clean
cd android && ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

## Release AAB

```bash
cd frontend
npx expo prebuild --platform android --clean
cd android && ./gradlew bundleRelease
```

Release builds need a signing keystore. Generate one, keep it out of the repo,
and reference it from `android/gradle.properties` (which prebuild regenerates,
so put the values in `~/.gradle/gradle.properties` instead).

## Regenerating icons

`assets/images/` is generated from `assets/icon-source.png` and
`assets/splash-source.png`:

```bash
pip install -r scripts/requirements-icons.txt
python scripts/build-icons.py
```

## Checks

```bash
npx tsc --noEmit                    # must be clean
npx eslint .                        # warnings only
npx expo export --platform android  # verifies the bundle builds
```

## Permissions

The shipped manifest declares only INTERNET, READ_EXTERNAL_STORAGE (image
picker), USE_BIOMETRIC / USE_FINGERPRINT (note lock) and VIBRATE (haptics).

`CAMERA` and `RECORD_AUDIO` are switched off at the `expo-image-picker` plugin,
since the app only ever opens the library picker. `SYSTEM_ALERT_WINDOW` and
`WRITE_EXTERNAL_STORAGE` are in `android.blockedPermissions`. React Native's own
debug manifest still declares `SYSTEM_ALERT_WINDOW`, so the dev menu keeps
working in debug builds while the permission stays out of release.

If you add a library that needs a permission, add it deliberately — do not
remove entries from `blockedPermissions` to make a build pass.
