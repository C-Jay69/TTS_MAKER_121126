/**
 * Tests for the Kokoro engine helpers (pure functions only).
 * Run: bun run scripts/test-kokoro.ts
 */

import { splitForKokoro, joinApiUrl, resolveKokoroDevice } from "../src/lib/studio/kokoroTts";
import { KOKORO_PIECE_MAX_CHARS, KOKORO_VOICES } from "../src/lib/studio/constants";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : "");
  }
}

{
  // Short text stays one piece
  check("short text single piece", splitForKokoro("Hello world.") .length === 1);

  // Long multi-sentence text packs into <=360-char pieces at sentence bounds
  const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1} walks quietly through the meadow with purpose.`).join(" ");
  const pieces = splitForKokoro(text);
  check("pieces within limit", pieces.every((p) => p.length <= KOKORO_PIECE_MAX_CHARS), pieces.map((p) => p.length));
  check("no sentence cut mid-way", pieces.every((p) => /[.!?]$/.test(p.trim())));
  check("all content preserved", pieces.join(" ").length >= text.length - 30);
}

{
  // Oversized single sentence is word-split, never dropped
  const monster = `${"word ".repeat(200)}end.`; // ~1005 chars, one sentence
  const pieces = splitForKokoro(monster);
  check("oversized sentence word-split", pieces.every((p) => p.length <= KOKORO_PIECE_MAX_CHARS) && pieces.length >= 3, pieces.map((p) => p.length));
  check("no words lost", pieces.join(" ").split(/\s+/).filter(Boolean).length === 201);
}

{
  // URL joining
  check("join: no double slash", joinApiUrl("http://localhost:8880/v1", "audio/speech") === "http://localhost:8880/v1/audio/speech");
  check("join: trailing slash base", joinApiUrl("http://localhost:8880/v1/", "audio/speech") === "http://localhost:8880/v1/audio/speech");
  check("join: leading slash path", joinApiUrl("http://localhost:8880/v1", "/audio/speech") === "http://localhost:8880/v1/audio/speech");
}

{
  // Device resolution: explicit values pass through
  check("device explicit webgpu", resolveKokoroDevice("webgpu") === "webgpu");
  check("device explicit wasm", resolveKokoroDevice("wasm") === "wasm");
}

{
  // Voice catalog sanity: unique ids, expected key voices present
  const ids = KOKORO_VOICES.map((v) => v.id);
  check("voice ids unique", new Set(ids).size === ids.length);
  check("af_heart present", ids.includes("af_heart"));
  check("bm_fable present", ids.includes("bm_fable"));
  check("28 voices", KOKORO_VOICES.length === 28, KOKORO_VOICES.length);
}

process.exit(failures > 0 ? 1 : 0);
