# GalaxyNotes — Samsung Notes Clone (PRD)

## Overview
Native-feeling Android notes app built with Expo + FastAPI + MongoDB that mirrors Samsung Notes' One UI 6 aesthetic and feature set.

## Tech
- Frontend: Expo Router (SDK 54), React Native, expo-blur, @shopify/react-native-skia, expo-image-picker
- Backend: FastAPI + Motor (MongoDB) on `/api`
- AI: Emergent LLM Key → Claude Sonnet 4-6 (note summarization)

## Navigation
- Bottom tabs: **Notes** • **Folders** • **Settings**
- Notes screen has a **left slide-in drawer** with:
  - All notes • Pinned • Trash
  - Folders list (color-tagged)
  - Manage folders • Settings shortcuts
- Note Editor opens as a stack screen above the tabs

## Features
- Notes CRUD with title, body, checklists, image attachments, drawings, folder, pin, lock
- **Soft-delete to Trash** with Restore + Empty Trash + permanent delete
- **Long-press a note card** for action menu: Pin / Lock / Move to folder / Duplicate / Move to trash (Trash mode shows Restore + Delete forever)
- **Template picker on FAB**: Blank • Checklist • Meeting notes • Journal entry • Drawing/S Pen
- **Stylus / S Pen drawing pad** with velocity-based variable stroke width (slow = thick, fast = thin), pen / highlighter / eraser, 6 colors, 3 widths, undo, clear
- Search across notes (debounced)
- Folders CRUD with custom color tags
- AI Summarize a note (Claude Sonnet 4-6 via Emergent LLM Key)
- Light / Dark / System theme (persisted)
- Local passcode for locked notes

## Backend Endpoints (`/api`)
- `GET /notes?status=active|trash&folder_id&pinned&q`, `POST /notes`
- `GET/PUT/DELETE /notes/{id}` (DELETE = soft-delete, `?permanent=true` = hard delete)
- `POST /notes/{id}/restore`, `POST /notes/trash/empty`
- `GET/POST /folders`, `PUT/DELETE /folders/{id}`
- `POST /ai/summarize`

