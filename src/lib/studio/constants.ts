/**
 * Shared constants and types for the Audiobook Studio.
 */

/** Hard upload limit: 5 MB. */
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

export const SUPPORTED_EXTENSIONS = [".txt", ".md", ".markdown", ".docx", ".pdf", ".doc"] as const;

/** Target chunk size window (characters). */
export const MIN_CHUNK_LENGTH = 1500;
export const MAX_CHUNK_LENGTH = 2500;

/** Max parallel Gemini TTS requests (respects API rate limits). */
export const TTS_CONCURRENCY = 2;

/** Automatic retries per chunk (on top of the first attempt). */
export const MAX_RETRIES = 2;

/** Base delay for exponential backoff (ms), with jitter added. */
export const RETRY_BASE_DELAY_MS = 800;

/** Average narration speed used for time estimates. */
export const WORDS_PER_MINUTE = 150;

/** Characters per second used to estimate live Web Speech duration. */
export const CHARS_PER_SECOND_SPEECH = 15;

/** Default Gemini TTS model (the TTS-enabled variant of Gemini 2.5 Flash). */
export const DEFAULT_TTS_MODEL = "gemini-2.5-flash-preview-tts";

/** Hugging Face repo used by the in-browser Kokoro engine (kokoro-js). */
export const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Default base URL for a local OpenAI-compatible Kokoro server (Kokoro-FastAPI). */
export const DEFAULT_KOKORO_SERVER_URL = "http://localhost:8880/v1";

/** Max characters per request sent to in-browser Kokoro (phoneme context is ~510 tokens). */
export const KOKORO_PIECE_MAX_CHARS = 360;

/** Silence inserted between Kokoro pieces (seconds). */
export const KOKORO_PIECE_GAP_SECONDS = 0.05;

/** Gemini endpoint base. */
export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Safety cap for in-browser WAV stitching (~450 MB of PCM). */
export const MAX_STITCH_BYTES = 450 * 1024 * 1024;

export interface GeminiVoice {
  name: string;
  style: string;
}

/** The 30 prebuilt Gemini TTS voices. */
export const GEMINI_VOICES: GeminiVoice[] = [
  { name: "Zephyr", style: "Bright" },
  { name: "Puck", style: "Upbeat" },
  { name: "Charon", style: "Informative" },
  { name: "Kore", style: "Firm" },
  { name: "Fenrir", style: "Excitable" },
  { name: "Leda", style: "Youthful" },
  { name: "Orus", style: "Firm" },
  { name: "Aoede", style: "Breezy" },
  { name: "Callirrhoe", style: "Easy-going" },
  { name: "Autonoe", style: "Bright" },
  { name: "Enceladus", style: "Breathy" },
  { name: "Iapetus", style: "Clear" },
  { name: "Umbriel", style: "Easy-going" },
  { name: "Algieba", style: "Smooth" },
  { name: "Despina", style: "Smooth" },
  { name: "Erinome", style: "Clear" },
  { name: "Algenib", style: "Gravelly" },
  { name: "Rasalgethi", style: "Informative" },
  { name: "Laomedeia", style: "Upbeat" },
  { name: "Achernar", style: "Soft" },
  { name: "Alnilam", style: "Firm" },
  { name: "Schedar", style: "Even" },
  { name: "Gacrux", style: "Mature" },
  { name: "Pulcherrima", style: "Forward" },
  { name: "Achird", style: "Friendly" },
  { name: "Zubenelgenubi", style: "Casual" },
  { name: "Vindemiatrix", style: "Gentle" },
  { name: "Sadachbia", style: "Lively" },
  { name: "Sadaltager", style: "Knowledgeable" },
  { name: "Sulafat", style: "Warm" },
];

export const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2.0] as const;

export type ChunkStatus = "pending" | "processing" | "ready" | "error";

export interface ManuscriptChunk {
  id: number;
  text: string;
  status: ChunkStatus;
  audioUrl: string | null;
  /** Duration in seconds (0 when unknown). */
  duration: number;
  /** Size of the generated WAV in bytes, when there is a Blob behind it. */
  byteSize?: number | null;
  error?: string | null;
  attempts?: number;
}

export type EngineKind = "gemini" | "webspeech" | "kokoro";

export type KokoroMode = "server" | "browser";
export type KokoroDevice = "auto" | "webgpu" | "wasm";

export interface ParseResult {
  text: string;
  warnings: string[];
}

export interface TtsSettings {
  engine: EngineKind;
  apiKey: string;
  model: string;
  /** Gemini voice name, Web Speech voice URI, or Kokoro voice id. */
  voice: string;
  /** Playback speed multiplier (0.75 - 2.0). */
  speed: number;
  /** Kokoro only: use a local HTTP server or run the model in this tab. */
  kokoroMode: KokoroMode;
  /** Kokoro server mode: OpenAI-compatible base URL. */
  kokoroServerUrl: string;
  /** Kokoro browser mode: inference device. */
  kokoroDevice: KokoroDevice;
}

export const DEFAULT_SETTINGS: TtsSettings = {
  engine: "gemini",
  apiKey: "",
  model: DEFAULT_TTS_MODEL,
  voice: "Kore",
  speed: 1,
  kokoroMode: "server",
  kokoroServerUrl: DEFAULT_KOKORO_SERVER_URL,
  kokoroDevice: "auto",
};

/** Sentinel voice id for "let the OS pick" in Web Speech mode. */
export const WEB_SPEECH_FALLBACK_VOICE = "auto";

/** Default voice per engine, applied when the user switches engines. */
export const ENGINE_DEFAULT_VOICE: Record<EngineKind, string> = {
  gemini: "Kore",
  kokoro: "af_heart",
  webspeech: WEB_SPEECH_FALLBACK_VOICE,
};

export interface KokoroVoice {
  id: string;
  name: string;
  gender: "Female" | "Male";
  accent: "American" | "British";
}

/** The 28 voices shipped with Kokoro-82M v1.0 (same ids on local servers). */
export const KOKORO_VOICES: KokoroVoice[] = [
  { id: "af_heart", name: "Heart", gender: "Female", accent: "American" },
  { id: "af_bella", name: "Bella", gender: "Female", accent: "American" },
  { id: "af_nicole", name: "Nicole", gender: "Female", accent: "American" },
  { id: "af_aoede", name: "Aoede", gender: "Female", accent: "American" },
  { id: "af_kore", name: "Kore", gender: "Female", accent: "American" },
  { id: "af_sarah", name: "Sarah", gender: "Female", accent: "American" },
  { id: "af_nova", name: "Nova", gender: "Female", accent: "American" },
  { id: "af_sky", name: "Sky", gender: "Female", accent: "American" },
  { id: "af_alloy", name: "Alloy", gender: "Female", accent: "American" },
  { id: "af_jessica", name: "Jessica", gender: "Female", accent: "American" },
  { id: "af_river", name: "River", gender: "Female", accent: "American" },
  { id: "am_fenrir", name: "Fenrir", gender: "Male", accent: "American" },
  { id: "am_michael", name: "Michael", gender: "Male", accent: "American" },
  { id: "am_puck", name: "Puck", gender: "Male", accent: "American" },
  { id: "am_echo", name: "Echo", gender: "Male", accent: "American" },
  { id: "am_eric", name: "Eric", gender: "Male", accent: "American" },
  { id: "am_liam", name: "Liam", gender: "Male", accent: "American" },
  { id: "am_onyx", name: "Onyx", gender: "Male", accent: "American" },
  { id: "am_santa", name: "Santa", gender: "Male", accent: "American" },
  { id: "am_adam", name: "Adam", gender: "Male", accent: "American" },
  { id: "bf_emma", name: "Emma", gender: "Female", accent: "British" },
  { id: "bf_isabella", name: "Isabella", gender: "Female", accent: "British" },
  { id: "bf_alice", name: "Alice", gender: "Female", accent: "British" },
  { id: "bf_lily", name: "Lily", gender: "Female", accent: "British" },
  { id: "bm_fable", name: "Fable", gender: "Male", accent: "British" },
  { id: "bm_george", name: "George", gender: "Male", accent: "British" },
  { id: "bm_lewis", name: "Lewis", gender: "Male", accent: "British" },
  { id: "bm_daniel", name: "Daniel", gender: "Male", accent: "British" },
];
