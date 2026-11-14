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

## Scripts

| Command | Purpose |
| ------- | ------- |
| `bun run dev` | Next.js dev server on **3000**, tees output to `dev.log` |
| `bun run build` | Production build (standalone output) |
| `bun run start` | Run the built standalone server |
| `bun run tts:server` | Kokoro TTS server on **8880** |
| `bun run lint` | ESLint |
| `bun run db:push` / `db:generate` / `db:migrate` / `db:reset` | Prisma helpers (see caveat below) |

## Configuration

`.env` currently holds one variable:

```
DATABASE_URL=file:/home/z/my-project/db/custom.db
```

That path is a leftover from the scaffold's original environment and does not exist on this
machine — again, harmless as long as you do not run the Prisma commands. Point it at
`file:./db/custom.db` if you ever want to use them.

Nothing in the studio UI reads the database — the Prisma schema (`User`, `Post`) and
`src/lib/db.ts` are leftover scaffolding, and the app stores its settings in browser
`localStorage` under `audiobook-studio.settings`. The Gemini API key is entered in the UI, not
via env.

## Project layout

```
src/app/               Next.js App Router entry (page.tsx renders <Studio/>)
src/components/studio/ Upload, controls, chunk reader, player bar, telemetry
src/components/ui/     shadcn/ui primitives
src/hooks/             use-tts-queue, use-player, use-toast, use-mobile
src/lib/studio/        chunker, parsers, geminiTts, kokoroTts, wav, constants, demo
scripts/               kokoro-server.py, standalone test scripts
prisma/, db/           Scaffold schema + SQLite file (unused by the app)
```

## Troubleshooting

- **`ECONNREFUSED` / "could not reach server" in Kokoro Server mode** — the 8880 server is not
  running, or the URL is wrong. Start it with `bun run tts:server` and check `/health`.
- **Port 8880 already in use** — something else holds it; start with `--port 8881` and update the
  URL in the app.
- **Other devices can't reach 8880** — it binds `127.0.0.1` by default; use `--host 0.0.0.0`.
- **Web Speech produces no exportable audio** — by design; that engine is live-only.
- **`next dev` warns about `package-lock.json` outside the repo** — harmless; the warning comes
  from Turbopack's inferred root. Set `turbopack.root` in `next.config.ts` to silence it.

## Notes

- `next.config.ts` sets `typescript.ignoreBuildErrors = true` and `output: "standalone"`, so a
  build will not fail on type errors — run `bunx tsc --noEmit` if you want that check.
- The `package.json` name is still `nextjs_tailwind_shadcn_ts` from the original scaffold.
