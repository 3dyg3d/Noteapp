# GalaxyNotes — Samsung Notes Clone (PRD)

## Overview
Native-feeling Android notes app built with Expo + FastAPI + MongoDB that mirrors Samsung Notes' One UI 6 aesthetic and core feature set.

## Tech
- Frontend: Expo Router (SDK 54), React Native, expo-blur, @shopify/react-native-skia (drawing), @gorhom/bottom-sheet, expo-image-picker
- Backend: FastAPI + Motor (MongoDB)
- AI: Emergent LLM Key → Claude Sonnet 4-6 (note summarization)

## Features
- Notes CRUD with title, rich body, checklists, image attachments, drawings, color/folder, pin, lock
- Folders CRUD with custom color tags
- Search across notes (title + content, debounced)
- Pinned section + grid/list view toggle
- Drawing canvas with pen / highlighter / eraser, 6 colors, 3 widths, undo, clear
- Image picker (compressed base64, gallery permission)
- AI Summarize a note (Claude Sonnet 4-6 via Emergent LLM Key)
- Light / Dark / System theme (persisted)
- Local passcode for locked notes (AsyncStorage)

## Screens (Expo Router)
- `/` — Home (notes grid/list, search, folder chips, FAB)
- `/note/[id]` — Editor (title, content, checklists, images, drawing, AI summary, pin/lock, folder picker)
- `/folders` — Manage folders (create/edit/delete + color)
- `/settings` — Theme toggle + passcode setup
- `/lock?noteId=...` — Passcode gate for locked notes

## Backend Endpoints (`/api`)
- `GET/POST /notes` , `GET/PUT/DELETE /notes/{id}`
- `GET/POST /folders`, `PUT/DELETE /folders/{id}`
- `POST /ai/summarize` → returns bullet summary

## Design
- Palette: Sage green brand (#7B8C73), monochrome surfaces, light/dark
- Spacing 8pt grid, radius lg/pill, frosted-glass sticky header
- Generous reachable top header (One UI vibe)
