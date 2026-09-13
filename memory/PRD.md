# Geodesic Notes — Product Requirements

## Overview
A handwriting-first notes app for Android and iOS. Typed notes, checklists,
images and a full stylus canvas, backed by a REST API.

The visual language is its own: clean surfaces, a single configurable accent,
generous spacing. Earlier drafts of this document described the app as a clone
of a specific vendor's notes app and referenced that vendor's design system.
That framing is gone. Feature parity with a competitor is not a requirement, and
shipping under someone else's design language is a legal and product liability.

## Tech
- **Frontend**: Expo Router (SDK 54), React Native 0.81, `@shopify/react-native-skia`,
  `react-native-gesture-handler` 2.28
- **Storage**: SQLite on device via `expo-sqlite`. No backend.

## No paid dependencies

The app runs entirely on free, self-hostable software. There is no LLM
provider, no API key, no metered call, and no account to register for anything
the app does at runtime.

Note summarization used to exist and has been removed: it was the only feature
that required a billed third-party service, and it is not worth a subscription
on a notes app. If it ever comes back it should be an optional, self-hosted
model, not a hosted API.

The only money anywhere near this project is the one-off Google Play developer
registration fee, and that is only if you publish to the Play Store. Building
and sideloading an APK costs nothing.

## Naming and storage
The app previously persisted preferences under a `galaxynotes:` key namespace.
Everything now lives under `geodesic:`, and `src/state/storageKeys.ts` is the
single registry for every persisted key. `migrateStorageNamespace()` copies the
old keys across once, so an existing install keeps its theme, tool widths,
saved colours and open tabs across the rename. The plaintext passcode from older
builds is re-hashed into secure storage rather than copied.

Bundle identifiers changed to `com.geodesic.notes`. That is a new app identity
to the stores, not an update to the old one.

## Navigation
- Notes list with a left slide-in drawer: All notes, Pinned, Trash, folders,
  labels
- Note editor as a stack screen
- Handwriting canvas as its own route

## Features
- Notes CRUD: title, body, checklists, image attachments, drawings, folder,
  label, pin, lock
- Soft-delete to Trash, with restore, empty, and permanent delete. Trashed notes
  are purged automatically after 30 days.
- Long-press a note card for pin / lock / move / duplicate / trash
- Templates on the compose action: blank, checklist, meeting notes, journal,
  handwriting
- Stylus canvas: pressure-aware variable stroke width, pen / fountain / marker /
  highlighter / pencil, eraser with whole-stroke and partial modes, shapes,
  ruler, multi-page paper styles, undo and redo
- Search across titles, bodies and checklist items
- Folders and labels with colour tags
- Light / dark / system theme
- Passcode and biometric lock for individual notes

## Ink pipeline
Handwriting quality is a primary requirement, not a nice-to-have.

- Strokes are **filled outlines**, not stroked polylines. One draw call per
  stroke, continuously variable width, tapered ends.
- Width is driven by **stylus pressure** where the digitiser reports it
  (`stylusData.pressure`), falling back to a velocity model for finger input.
- Smoothing is **centripetal Catmull-Rom with corner detection**, so the point
  of a `v` and the junction of a `t` survive.
- Timing uses a **sub-millisecond clock**. `Date.now()` cannot resolve 120 Hz
  sampling.
- The wet stroke renders in an **isolated layer** driven by a ref. A pen sample
  must never re-render the canvas screen or rebuild a committed stroke's path.
- Committed paths are **cached against stroke identity** and the renderer is
  memoized on it.
- Simplification runs **once, at commit**, measuring both positional and
  pressure error.

## Data boundaries

- Everything is local. `src/api/client.ts` keeps the old HTTP client's exported
  signatures so no screen changed, but every call now hits SQLite.
- The notes list selects **summary columns only**. `drawing_data`, `images` and
  `drawings` are never read by the list; cards render from a small bounded
  `preview` written at save time.
- Writes are patches. An omitted key is untouched; an explicit `null` clears the
  column. This is what makes "move a note out of its folder" expressible.
- Deletes are idempotent. Only an explicit `permanent` destroys.
- Search uses `LIKE` with `ESCAPE`, so a query of `100%` matches the literal
  rather than every note.
- Trash older than 30 days is purged at startup, since there is no server timer.

## Known gaps
These are open, not done:

- **No backup or export.** The database lives only in app-private storage and
  goes away with an uninstall. This is the most important gap.
- **Note bodies are not encrypted at rest.** "Locked" gates the UI on this
  device; it is not protection against someone holding the unlocked phone.
- **No sync.** Deliberate, but the `version` column is retained so adding it
  later is not a migration.
- `app/index.tsx` and `app/draw/[id].tsx` are single components of ~3,600 and
  ~4,400 lines. Not a correctness bug, but the reason most fixes are harder than
  they should be.
- No frontend test setup.
