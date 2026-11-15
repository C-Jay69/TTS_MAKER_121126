/**
 * Gemini TTS client (browser-side, user-supplied API key).
 *
 * Uses the Gemini `generateContent` endpoint with native audio output
 * (responseModalities: ["AUDIO"]). The TTS-capable models are the
 * `*-preview-tts` variants; the model name is configurable in Settings.
 */

import { GEMINI_API_BASE } from "./constants";
import { base64ToUint8Array, pcmToWav } from "./wav";

/** Errors that carry whether an automatic retry makes sense. */
export class TtsError extends Error {
  retryable: boolean;
  /**
   * Machine-readable classification used by the queue. `transport` means the
   * engine could not be reached at all — worth pausing the whole batch rather
   * than burning through every remaining chunk.
   */
  code?: "transport" | "config" | "http";

  constructor(message: string, retryable: boolean, code?: TtsError["code"]) {
    super(message);
    this.name = "TtsError";
    this.retryable = retryable;
    this.code = code;
  }
}

export interface GeminiTtsParams {
  apiKey: string;
  model: string;
  voice: string;
}

export interface SynthesisResult {
  wav: Blob;
  duration: number;
}

const NARRATION_PROMPT =
  "Read the following passage aloud as an audiobook narrator, in a natural, clear and engaging tone with even pacing. Read only the passage itself, without any commentary:\n\n";

export async function synthesizeWithGemini(
  text: string,
  params: GeminiTtsParams,
  signal?: AbortSignal,
): Promise<SynthesisResult> {
  let response: Response;
  try {
    response = await fetch(`${GEMINI_API_BASE}/${encodeURIComponent(params.model)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": params.apiKey,
      },
      signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${NARRATION_PROMPT}${text}` }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: params.voice },
            },
          },
        },
      }),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new TtsError(`Network error while contacting Gemini: ${(err as Error).message}`, true, "transport");
  }

  if (!response.ok) {
    let message = `Gemini API error (HTTP ${response.status})`;
    let retryable = response.status === 429 || response.status === 408 || response.status >= 500;
    try {
      const body = (await response.json()) as { error?: { message?: string; status?: string } };
      if (body?.error?.message) message = body.error.message;
      if (body?.error?.status === "RESOURCE_EXHAUSTED") retryable = true;
      if (body?.error?.status === "UNAVAILABLE") retryable = true;
    } catch {
      /* keep defaults */
    }
    throw new TtsError(message, retryable);
  }

  let data: {
    candidates?: Array<{
      finishReason?: string;
      content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
    }>;
    promptFeedback?: { blockReason?: string };
  };

  try {
    data = await response.json();
  } catch {
    throw new TtsError("Gemini returned a malformed response", true);
  }

  const candidate = data.candidates?.[0];
  const inline = candidate?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;

  if (!inline?.data) {
    const reason = candidate?.finishReason ?? data.promptFeedback?.blockReason ?? "NO_AUDIO";
    const blocked = reason === "SAFETY" || reason === "PROHIBITED_CONTENT" || reason === "BLOCKED";
    throw new TtsError(
      blocked
        ? `Gemini blocked this chunk for safety reasons (${reason}). Try rewording the passage.`
        : `Gemini returned no audio (finishReason: ${reason}).`,
      false,
    );
  }

  const rateMatch = /rate=(\d+)/.exec(inline.mimeType ?? "");
  const sampleRate = rateMatch ? Number.parseInt(rateMatch[1], 10) : 24000;
  const pcm = base64ToUint8Array(inline.data);

  if (pcm.length === 0) {
    throw new TtsError("Gemini returned an empty audio stream", true);
  }

  const wavBuffer = pcmToWav(pcm, sampleRate, 1, 16);
  const duration = pcm.length / 2 / sampleRate; // 16-bit mono -> 2 bytes per sample
  return { wav: new Blob([wavBuffer], { type: "audio/wav" }), duration };
}
