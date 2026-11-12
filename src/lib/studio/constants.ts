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
  error?: string | null;
  attempts?: number;
}

export type EngineKind = "gemini" | "webspeech";

export interface ParseResult {
  text: string;
  warnings: string[];
}

export interface TtsSettings {
  engine: EngineKind;
  apiKey: string;
  model: string;
  /** Gemini voice name, or a Web Speech voice URI when engine = webspeech. */
  voice: string;
  /** Playback speed multiplier (0.75 - 2.0). */
  speed: number;
}

export const DEFAULT_SETTINGS: TtsSettings = {
  engine: "gemini",
  apiKey: "",
  model: DEFAULT_TTS_MODEL,
  voice: "Kore",
  speed: 1,
};

export const WEB_SPEECH_FALLBACK_VOICE = "auto";
