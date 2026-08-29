# Geodesic Notes

A handwriting-first notes app. Expo + React Native on the front, FastAPI +
MongoDB on the back.

## Layout

```
backend/     FastAPI service, mounted at /api
frontend/    Expo Router app
memory/      Product requirements
```

## Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # add -dev for tests and linters
cp .env.example .env                     # then fill in MONGO_URL
uvicorn server:app --reload
```

`GET /api/health` pings the database and is the readiness probe.

There are no API keys to configure. The service needs a MongoDB connection and
nothing else: no LLM provider, no third-party account, no metered calls.

### Tests

```bash
pip install -r requirements-dev.txt
GEODESIC_API_URL=http://localhost:8000 pytest backend/tests
```

These are integration tests and write real notes, so point them at a scratch
database rather than anything you care about.

## Frontend

```bash
cd frontend
yarn install
yarn start
```

Set `EXPO_PUBLIC_BACKEND_URL` to the API's origin. The handwriting canvas needs
a real device or simulator; Skia does not render in the web preview.

## Cost

Nothing here requires a subscription or a paid service. MongoDB Community
Server is free and self-hosted, and every dependency is open source. Building
and sideloading the APK costs nothing; only publishing to the Play Store
carries Google's one-off developer registration fee.

## Notes on the current state

- **There is no authentication.** Every client reads and writes one shared
  collection. Note locking gates access on the device; the server stores note
  bodies in the clear. Do not deploy this to the open internet as-is.
- **There is no offline mode.** The app needs the API to show anything.
- `app/index.tsx` and `app/draw/[id].tsx` are single components of roughly 3,600
  and 4,400 lines.
- There is no frontend test setup.

See `memory/PRD.md` for the full picture, including the ink pipeline and the
data-shape rules the API depends on.
