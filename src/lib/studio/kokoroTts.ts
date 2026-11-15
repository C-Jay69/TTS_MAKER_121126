/**
 * Local Kokoro TTS engine — two ways to use a model on the user's machine:
 *
 * 1. Server mode: POST to a local OpenAI-compatible endpoint
 *    (e.g. Kokoro-FastAPI at http://localhost:8880/v1/audio/speech).
 * 2. Browser mode: run Kokoro-82M directly in this tab via kokoro-js /
 *    onnxruntime-web (weights are downloaded once and cached by the browser).
 *
 * Both return real WAV blobs, so per-chunk downloads and full-audiobook
 * export work exactly like the Gemini engine.
 */

import {
  KOKORO_MODEL_ID,
  KOKORO_PIECE_GAP_SECONDS,
  KOKORO_PIECE_MAX_CHARS,
} from "./constants";
import { TtsError } from "./geminiTts";
import { parseWavHeader, pcmToWav } from "./wav";
import { splitSentences } from "./chunker";

export interface SynthesisResult {
  wav: Blob;
  duration: number;
}

/* ------------------------------------------------------------------ */
/* Server mode (OpenAI-compatible /audio/speech)                       */
/* ------------------------------------------------------------------ */

export interface KokoroServerParams {
  baseUrl: string;
  voice: string;
  speed: number;
}

/** Join a base URL and path without double slashes. */
export function joinApiUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export async function synthesizeWithKokoroServer(
  text: string,
  params: KokoroServerParams,
  signal?: AbortSignal,
): Promise<SynthesisResult> {
  if (!params.baseUrl.trim()) {
    throw new TtsError(
      "No Kokoro server URL configured. Add it in the Voice engine panel.",
      false,
      "config",
    );
  }
  const url = joinApiUrl(params.baseUrl, "audio/speech");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: "kokoro",
        input: text,
        voice: params.voice || "af_heart",
        response_format: "wav",
        speed: params.speed,
      }),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new TtsError(
      `Could not reach the local Kokoro server at ${url}. Make sure it is running and allows browser requests (CORS).`,
      true,
      "transport",
    );
  }

  if (!response.ok) {
    let message = `Kokoro server error (HTTP ${response.status})`;
    let retryable = response.status === 429 || response.status === 408 || response.status >= 500;
    try {
      const body = (await response.json()) as { error?: { message?: string } | string; detail?: unknown };
      const detail =
        typeof body?.error === "string"
          ? body.error
          : body?.error?.message ?? (typeof body?.detail === "string" ? body.detail : JSON.stringify(body?.detail));
      if (detail) message = `Kokoro server: ${detail}`;
    } catch {
      /* keep defaults */
    }
    throw new TtsError(message, retryable, "http");
  }

  const wav = await response.blob();

  // Derive the duration from the WAV header when possible.
  let duration = 0;
  try {
    const meta = parseWavHeader(await wav.arrayBuffer());
    duration = meta.dataLength / 2 / meta.sampleRate; // assume 16-bit
  } catch {
    // Not a WAV (server returned mp3/opus): rough estimate from bytes.
    duration = wav.size / 48000;
  }

  if (!Number.isFinite(duration) || duration <= 0) duration = 0;
  return { wav, duration };
}

/* ------------------------------------------------------------------ */
/* Browser mode (kokoro-js + onnxruntime-web)                          */
/* ------------------------------------------------------------------ */

export interface KokoroBrowserParams {
  voice: string;
  speed: number;
  device: "auto" | "webgpu" | "wasm";
  onProgress?: (progress: { stage: "loading" | "generating"; ratio: number }) => void;
}

type KokoroTtsInstance = Awaited<ReturnType<typeof loadKokoroModel>>;

let modelPromise: Promise<KokoroTtsInstance> | null = null;
let modelDeviceKey = "";

async function loadKokoroModel(
  device: "webgpu" | "wasm",
  onProgress?: KokoroBrowserParams["onProgress"],
) {
  // Dynamic import keeps the (large) inference stack out of the main bundle.
  const [mod, transformers] = await Promise.all([import("kokoro-js"), import("@huggingface/transformers")]);
  // Run ONNX inference inside a web worker so the UI thread stays responsive
  // during long synthesizes (default is main-thread, which freezes the page).
  transformers.env.backends.onnx.wasm.proxy = true;
  const dtype = device === "webgpu" ? ("fp32" as const) : ("q8" as const);
  return await mod.KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
    device,
    dtype,
    progress_callback: (info: { status?: string; loaded?: number; total?: number }) => {
      if (info?.status === "progress" && info.total && info.loaded !== undefined) {
        onProgress?.({ stage: "loading", ratio: Math.min(1, info.loaded / info.total) });
      }
    },
  });
}

/**
 * Load the model with a device preference; WebGPU failures (common on
 * machines without a working GPU adapter) transparently fall back to WASM.
 */
async function loadKokoroModelWithFallback(
  device: "webgpu" | "wasm",
  onProgress?: KokoroBrowserParams["onProgress"],
) {
  if (device === "wasm") return await loadKokoroModel("wasm", onProgress);
  try {
    return await loadKokoroModel("webgpu", onProgress);
  } catch (err) {
    onProgress?.({ stage: "loading", ratio: 0 });
    try {
      return await loadKokoroModel("wasm", onProgress);
    } catch (wasmErr) {
      // Surface BOTH failures so the user sees why each device was rejected.
      throw new Error(
        `${(err as Error)?.message ?? "WebGPU failed"}; WASM fallback also failed: ${(wasmErr as Error)?.message ?? "unknown"}`,
      );
    }
  }
}

/** Resolve "auto" to the best available device. */
export function resolveKokoroDevice(device: "auto" | "webgpu" | "wasm"): "webgpu" | "wasm" {
  if (device === "auto") {
    return typeof navigator !== "undefined" && "gpu" in navigator ? "webgpu" : "wasm";
  }
  return device;
}

/** Serialize inference: one onnxruntime session should not run concurrently. */
let inferenceChain: Promise<unknown> = Promise.resolve();
function enqueueInference<T>(task: () => Promise<T>): Promise<T> {
  const run = inferenceChain.then(task, task);
  inferenceChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Split text into sentence-packed pieces small enough for Kokoro's phoneme
 * context (the tokenizer truncates anything longer, which would silently
 * drop the end of the chunk).
 */
export function splitForKokoro(text: string, maxLen = KOKORO_PIECE_MAX_CHARS): string[] {
  if (text.length <= maxLen) return [text];
  const pieces: string[] = [];
  let buf = "";
  for (const sentence of splitSentences(text)) {
    const units = sentence.length > maxLen ? splitOversizedByWords(sentence, maxLen) : [sentence];
    for (const unit of units) {
      if (buf && buf.length + 1 + unit.length > maxLen) {
        pieces.push(buf);
        buf = unit;
      } else {
        buf = buf ? `${buf} ${unit}` : unit;
      }
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
}

function splitOversizedByWords(sentence: string, maxLen: number): string[] {
  const words = sentence.split(" ");
  const parts: string[] = [];
  let buf = "";
  for (const w of words) {
    if (buf && buf.length + 1 + w.length > maxLen) {
      parts.push(buf);
      buf = w;
    } else {
      buf = buf ? `${buf} ${w}` : w;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

export async function synthesizeWithKokoroBrowser(
  text: string,
  params: KokoroBrowserParams,
  signal?: AbortSignal,
): Promise<SynthesisResult> {
  const device = resolveKokoroDevice(params.device);
  const onProgress = params.onProgress;

  onProgress?.({ stage: "loading", ratio: 0 });
  if (!modelPromise || modelDeviceKey !== device) {
    modelDeviceKey = device;
    modelPromise = loadKokoroModelWithFallback(device, onProgress).catch((err) => {
      modelPromise = null; // allow a retry on the next attempt
      throw new TtsError(
        `Failed to load the Kokoro model (${(err as Error)?.message ?? "unknown error"}). ` +
          "The first run downloads the model weights; check your connection.",
        true,
      );
    });
  }
  const tts = await modelPromise;

  const pieces = splitForKokoro(text);
  const buffers: Float32Array[] = [];
  let samplingRate = 24000;

  onProgress?.({ stage: "generating", ratio: 0 });
  for (let i = 0; i < pieces.length; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const audio = await enqueueInference(() =>
      tts.generate(pieces[i], {
        voice: (params.voice || "af_heart") as never,
        speed: params.speed,
      }),
    );
    samplingRate = audio.sampling_rate;
    buffers.push(audio.audio as Float32Array);
    onProgress?.({ stage: "generating", ratio: (i + 1) / pieces.length });
  }

  // Join pieces with a short silence, then encode 16-bit PCM WAV.
  const silence = new Float32Array(Math.round(KOKORO_PIECE_GAP_SECONDS * samplingRate));
  const totalLength = buffers.reduce((acc, b) => acc + b.length + silence.length, 0);
  const joined = new Float32Array(totalLength);
  let offset = 0;
  for (const buffer of buffers) {
    joined.set(buffer, offset);
    offset += buffer.length;
    joined.set(silence, offset);
    offset += silence.length;
  }

  const pcm = new Int16Array(joined.length);
  for (let i = 0; i < joined.length; i++) {
    const sample = Math.max(-1, Math.min(1, joined[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const wavBuffer = pcmToWav(new Uint8Array(pcm.buffer), samplingRate, 1, 16);
  const duration = joined.length / samplingRate;
  return { wav: new Blob([wavBuffer], { type: "audio/wav" }), duration };
}
