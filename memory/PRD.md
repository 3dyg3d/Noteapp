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
- **Backend**: FastAPI + Motor (MongoDB), mounted at `/api`

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
- The notes list returns **summaries only**. `drawing_data`, `drawings` and
  `images` are projected out. Cards render from a small bounded `preview` field
  written at save time.
- Full documents are fetched one note at a time; handwriting payloads have their
  own endpoint.
- Writes are patches. An omitted key is untouched; an explicit `null` clears the
  field. This is what makes "move a note out of its folder" expressible.
- Writes carry a `version` for optimistic concurrency and get a 409 rather than
  clobbering a concurrent edit.
- Deletes are idempotent. Only `permanent=true` destroys.

## Backend endpoints (`/api`)
- `GET /health`
- `GET /notes` (paginated summaries: `status`, `folder_id`, `label_id`, `q`,
  `pinned`, `limit`, `offset`), `POST /notes`
- `GET/PUT/DELETE /notes/{id}`, `GET /notes/{id}/drawing`
- `POST /notes/{id}/restore`, `POST /notes/trash/empty`
- `GET/POST /folders`, `PUT/DELETE /folders/{id}`
- `GET/POST /labels`, `PUT/DELETE /labels/{id}`

## Known gaps
These are open, not done:

- **No authentication.** Every client shares one notes collection. "Locked"
  currently means gated on this device; the server still stores note bodies in
  the clear. Real at-rest protection needs the body encrypted under a key
  derived from the passcode.
- **No offline mode.** The app renders nothing without a network.
- `app/index.tsx` and `app/draw/[id].tsx` are single components of ~3,600 and
  ~4,400 lines. Not a correctness bug, but the reason most fixes are harder than
  they should be.
- No frontend test setup.
