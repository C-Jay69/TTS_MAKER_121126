# Audiobook Studio

Turn long manuscripts (`.txt`, `.md`, `.markdown`, `.docx`, `.pdf`, `.doc`) into spoken audio.
Files are parsed and chunked in the browser, narrated chunk-by-chunk with pause/resume/retry,
played back gaplessly, and exported as a single WAV.

This is a Next.js 16 app with three selectable TTS engines — two run locally, one is a cloud API.

## Ports at a glance

| Port | What runs there | Command |
| ---- | --------------- | ------- |
| **3000** | The Next.js web app | `bun run dev` |
| **8880** | The **Kokoro TTS server** (OpenAI-compatible API) | `bun run tts:server` |

Port 8880 is **not** the web app. It is the local Kokoro backend the app talks to when you pick
"Local Kokoro → Server" as your engine.

## Run the Kokoro server on port 8880

```bash
bun run tts:server
```

Equivalent commands:

```bash
npm run tts:server
```

```bash
# explicit — the port already defaults to 8880, this just makes it visible
/home/c-jay69/venv/bin/python scripts/kokoro-server.py --port 8880
```

```bash
# bind to all interfaces so other devices on the LAN can reach it
/home/c-jay69/venv/bin/python scripts/kokoro-server.py --port 8880 --host 0.0.0.0
```

The server reuses the Kokoro install already present in `/home/c-jay69/venv` (the `kokoro`
package plus the `hexgrad/Kokoro-82M` weights) and only imports the Python standard library.
Override the interpreter with `KOKORO_PYTHON=/path/to/python bun run tts:server`; override the
port with `KOKORO_PORT=8881`.

Check it is up:

```bash
curl http://127.0.0.1:8880/health
curl http://127.0.0.1:8880/v1/models
```

Endpoints exposed:

- `POST /v1/audio/speech` — `{model, input, voice, response_format, speed}` → WAV
- `GET /v1/models`
- `GET /health`

## Run the web app

```bash
bun install
bun run dev          # http://localhost:3000
```

Then in the app: **Voice engine → Local Kokoro → Server**, and set the server URL to
`http://localhost:8880/v1` (that is already the default).

## TTS engines

| Engine | Where it runs | Needs | Notes |
| ------ | ------------- | ----- | ----- |
| **Gemini TTS** | Google cloud | Gemini API key (entered in the UI) | `gemini-2.5-flash-preview-tts` or `gemini-2.5-pro-preview-tts`; 30 prebuilt voices. Key is stored only in this browser's `localStorage` and sent straight to Google. |
| **Local Kokoro** (`server`) | Your machine, via port 8880 | The Kokoro server above | OpenAI-compatible `/v1/audio/speech`. Works with Kokoro-FastAPI, kokoro-onnx, or anything speaking that shape. |
| **Local Kokoro** (`browser`) | This tab | Nothing to install | `kokoro-js` + ONNX runtime; model weights download once and are cached by the browser. CPU or WebGPU. |
| **Web Speech API** | The browser | A system voice | Free and instant, but audio is not recorded — no per-chunk WAV, no audiobook export. |

Gemini and both Kokoro modes return real WAV blobs, so per-chunk download and full-book
export work with all three.

## How a run works

1. **Upload** — `src/lib/studio/parsers.ts` extracts text from the manuscript (PDF via
   `pdfjs-dist`, DOCX via `mammoth`, Markdown stripped to prose). Limit: 5 MB.
2. **Chunk** — `src/lib/studio/chunker.ts` splits into 1500–2500 character pieces on sentence
   and paragraph boundaries so no chunk exceeds the model's context.
3. **Synthesize** — `src/hooks/use-tts-queue.ts` works through the queue with limited
   concurrency, automatic retries with exponential backoff, and pause/resume/cancel.
4. **Play / export** — `src/hooks/use-player.ts` for gapless playback; `src/lib/studio/wav.ts`
   stitches chunk PCM into one downloadable WAV.
5. **Save** — the **Projects** dialog snapshots the manuscript, settings and chunk metadata to
   Postgres, where it can be reopened later.

## Persistence (Supabase Postgres)

Projects, their chunks and generated-audio metadata live in Postgres via Prisma. The schema is
`prisma/schema.prisma`; the initial migration is in `prisma/migrations/`.

| Table        | Holds |
| ------------ | ----- |
| `Project`    | Name, source file, the full manuscript text, word count and the non-secret TTS settings (engine, voice, model, speed). |
| `Chunk`      | One row per manuscript chunk: text, status, measured duration, WAV byte size, retry count and last error. Unique on `(projectId, index)`. |
| `AudioAsset` | Metadata for audio the browser produced — a stitched full-book export, size, duration, sample rate, engine and voice. |

What is **not** stored server-side:

- **Audio bytes.** WAV blobs stay in the tab as object URLs (or are downloaded). Storing them
  needs a Supabase Storage bucket plus `SUPABASE_SERVICE_ROLE_KEY`, which this project does not
  use. The `AudioAsset.storage` column is already there (`browser` today) for that upgrade.
- **The Gemini API key.** It only ever lives in the browser's `localStorage`
  (`audiobook-studio.settings`) and is sent straight to Google.

Reloading a project restores the manuscript and settings and re-chunks the text, but the audio
must be regenerated. Chunk rows keep their last known duration and byte size across such a save,
so the history survives.

### Project API

All routes are JSON and `force-dynamic` (never cached). There is **no authentication** — the app
is built to run on localhost, so do not expose it to the internet as-is.

| Method + route | Purpose |
| -------------- | ------- |
| `GET /api/projects` | List projects with chunk/ready counts and total audio length |
| `POST /api/projects` | Create a project from a full snapshot (manuscript + chunks) |
| `GET /api/projects/:id` | Full project including chunks and recent exports |
| `PATCH /api/projects/:id` | Replace the snapshot (upserts chunks, trims the tail) |
| `DELETE /api/projects/:id` | Delete a project (chunks and assets cascade) |
| `POST /api/projects/:id/exports` | Record metadata of an audio file the browser produced |

## Scripts

| Command | Purpose |
| ------- | ------- |
| `bun run dev` | Next.js dev server on **3000**, tees output to `dev.log` |
| `bun run build` | `prisma generate` + production build (standalone output) |
| `bun run start` | Run the built standalone server |
| `bun run tts:server` | Kokoro TTS server on **8880** |
| `bun run lint` | ESLint |
| `bun run db:migrate` | Create + apply a migration in development |
| `bun run db:deploy` | Apply pending migrations in production/CI |
| `bun run db:generate` | Regenerate the Prisma client after a schema change |
| `bun run db:push` | Push the schema without a migration file |
| `bun run db:reset` | Drop and recreate the database (destructive) |

## Configuration

`.env` (untracked; `.env*` is in `.gitignore`):

```
DATABASE_URL=postgresql://postgres:...@db.<project-ref>.supabase.co:5432/postgres
SUPABASE_URL=https://<project-ref>.supabase.co
OPEN_ROUTER_API_KEY=sk-or-v1-...
```

| Variable | Used by | Notes |
| -------- | ------- | ----- |
| `DATABASE_URL` | Prisma, the API routes | Direct Supabase connection on `:5432`. For serverless deploys switch to the pooler (`:6543` with `?pgbouncer=true`). |
| `SUPABASE_URL` | nothing yet | Present for a future Storage integration. |
| `OPEN_ROUTER_API_KEY` | nothing yet | Verified working, but OpenRouter only offers speech output through `openai/gpt-audio`, which this app does not call. |

The Gemini key is entered in the **Voice engine** panel, not via env.

## Project layout

```
src/app/               Next.js App Router entry + /api/projects route handlers
src/components/studio/ Upload, controls, projects dialog, chunk reader, player bar, telemetry
src/components/ui/     shadcn/ui primitives
src/hooks/             use-tts-queue, use-player, use-project-persistence, use-toast
src/lib/studio/        chunker, parsers, geminiTts, kokoroTts, wav, constants, projects (types)
src/lib/server/        projects data layer + route helpers (Prisma, server-only)
scripts/               kokoro-server.py, standalone test scripts
prisma/                Schema + migrations
db/                    Legacy SQLite file from the original scaffold (unused)
```

## Troubleshooting

- **`ECONNREFUSED` / "could not reach server" in Kokoro Server mode** — the 8880 server is not
  running, or the URL is wrong. Start it with `bun run tts:server` and check `/health`.
- **Port 8880 already in use** — something else holds it; start with `--port 8881` and update the
  URL in the app.
- **Other devices can't reach 8880** — it binds `127.0.0.1` by default; use `--host 0.0.0.0`.
- **Web Speech produces no exportable audio** — by design; that engine is live-only.
- **Projects fail with a 503 "Cannot reach the Postgres database"** — Supabase paused the project
  (free tier sleeps), `DATABASE_URL` is wrong, or the network is IPv6-only while the direct host
  resolves to IPv4. Resume the project in the Supabase dashboard and retry.
- **`prisma migrate dev` cannot create a shadow database** — use `bun run db:push`, or point
  `shadowDatabaseUrl` at a scratch database.
- **Buttons do nothing / nothing is interactive in dev** — you opened `http://127.0.0.1:3000`
  instead of `http://localhost:3000`. Next 16 rejects the HMR socket for that origin, hydration
  never attaches, and the page stays static. Use `localhost`.
- **`next dev` warns about `package-lock.json` outside the repo** — harmless; the warning comes
  from Turbopack's inferred root. Set `turbopack.root` in `next.config.ts` to silence it.

## Notes

- `next.config.ts` sets `typescript.ignoreBuildErrors = true` and `output: "standalone"`, so a
  build will not fail on type errors — run `bunx tsc --noEmit` if you want that check.
- The `package.json` name is still `nextjs_tailwind_shadcn_ts` from the original scaffold.
- `db/custom.db` and the old `User`/`Post` models are gone; the SQLite file is no longer read.
