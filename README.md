# Geodesic Notes

A handwriting-first Android notes app. Fully offline: notes live in a SQLite
database on the device. There is no server, no account, no network call.

The app ships without the `INTERNET` permission, so this is enforced by Android
rather than merely intended.

## Build

```bash
cd frontend
npm install
npx expo prebuild --platform android --clean
npx expo export:embed \
  --platform android --dev false \
  --entry-file node_modules/expo-router/entry.js \
  --bundle-output android/app/src/main/assets/index.android.bundle \
  --assets-dest android/app/src/main/res
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The `export:embed` step bundles the JavaScript into the APK. Without it a debug
build expects a Metro server at runtime and hangs on the splash screen.

Requires: JDK 17+, Android SDK platform 35, build-tools 35.0.0,
NDK 27.1.12297006. On Fedora, `./scripts/setup-fedora.sh` installs them.

## Where data lives

`geodesic.db` in the app's private storage, created and migrated on first
launch by `src/db/index.ts`. Uninstalling the app deletes it. There is no sync
and no automatic backup.

`src/api/client.ts` keeps the old HTTP client's exact function signatures
(`NotesApi.list()`, `NotesApi.update()` and so on) but reads and writes SQLite.
The screens were not changed.

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
```

## Notes on the current state

- No sync between devices, by design.
- No backup or export yet. Worth adding before you rely on it.
- Note locking gates access on this device. Note bodies are not encrypted at
  rest, so a passcode is not protection against someone with the device
  unlocked and a file browser.
- `app/index.tsx` and `app/draw/[id].tsx` are single components of roughly 3,600
  and 4,400 lines.
- No frontend test setup.
