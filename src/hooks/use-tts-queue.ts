"use client";

/**
 * TTS queue worker.
 *
 * Processes manuscript chunks sequentially/with limited concurrency,
 * automatic retries with exponential backoff, and full pause / resume /
 * cancel control. Owns all object URLs and revokes them deterministically
 * (chunk replacement, reset, unmount, beforeunload) to avoid memory leaks.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  CHARS_PER_SECOND_SPEECH,
  MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
  TTS_CONCURRENCY,
  type ManuscriptChunk,
  type TtsSettings,
} from "@/lib/studio/constants";
import { chunkText } from "@/lib/studio/chunker";
import { TtsError, synthesizeWithGemini } from "@/lib/studio/geminiTts";
import {
  synthesizeWithKokoroBrowser,
  synthesizeWithKokoroServer,
} from "@/lib/studio/kokoroTts";

export type QueuePhase = "idle" | "running" | "paused";

export interface BatchSummary {
  ready: number;
  failed: number;
  total: number;
}

export interface TtsQueueApi {
  chunks: ManuscriptChunk[];
  /** Replace the whole chunk list (after parsing a new file). Revokes old URLs. */
  resetChunks: (text: string) => void;
  clearAll: () => void;
  start: () => void;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
  retryChunk: (id: number) => void;
  phase: QueuePhase;
  totalCount: number;
  readyCount: number;
  errorCount: number;
  doneCount: number;
  getChunkBlob: (id: number) => Promise<Blob | null>;
}

function makeChunk(id: number, text: string): ManuscriptChunk {
  return { id, text, status: "pending", audioUrl: null, duration: 0, error: null, attempts: 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function estimateSpeechDuration(text: string): number {
  return text.length / CHARS_PER_SECOND_SPEECH;
}

export function useTtsQueue(
  settings: TtsSettings,
  options?: {
    onComplete?: (summary: BatchSummary) => void;
    onNotify?: (message: string, kind?: "error" | "info") => void;
  },
): TtsQueueApi {
  const [chunks, setChunks] = useState<ManuscriptChunk[]>([]);
  const [phase, setPhase] = useState<QueuePhase>("idle");

  const chunksRef = useRef<ManuscriptChunk[]>([]);
  const settingsRef = useRef(settings);
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const runTokenRef = useRef(0);
  const abortControllersRef = useRef(new Map<number, AbortController>());
  const objectUrlsRef = useRef(new Set<string>());
  const onCompleteRef = useRef(options?.onComplete);
  const onNotifyRef = useRef(options?.onNotify);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    onCompleteRef.current = options?.onComplete;
    onNotifyRef.current = options?.onNotify;
  }, [options?.onComplete, options?.onNotify]);

  /* ------------------------- object URL bookkeeping ------------------------- */

  const createAudioUrl = useCallback((blob: Blob): string => {
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.add(url);
    return url;
  }, []);

  const revokeAudioUrl = useCallback((url: string | null | undefined) => {
    if (!url) return;
    if (objectUrlsRef.current.has(url)) {
      URL.revokeObjectURL(url);
      objectUrlsRef.current.delete(url);
    }
  }, []);

  const revokeAll = useCallback(() => {
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
    objectUrlsRef.current.clear();
  }, []);

  // Cleanup on unmount and on page close.
  useEffect(() => {
    const handleUnload = () => revokeAll();
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      revokeAll();
    };
  }, [revokeAll]);

  /* ------------------------------ state helpers ----------------------------- */

  const updateChunk = useCallback((id: number, patch: Partial<ManuscriptChunk>) => {
    chunksRef.current = chunksRef.current.map((c) => (c.id === id ? { ...c, ...patch } : c));
    setChunks(chunksRef.current);
  }, []);

  const resetChunks = useCallback(
    (text: string) => {
      runTokenRef.current += 1;
      runningRef.current = false;
      pausedRef.current = false;
      for (const controller of abortControllersRef.current.values()) controller.abort();
      abortControllersRef.current.clear();
      revokeAll();
      const next = chunkTextToChunks(text);
      chunksRef.current = next;
      setChunks(next);
      setPhase("idle");
    },
    [revokeAll],
  );

  const clearAll = useCallback(() => {
    runTokenRef.current += 1;
    runningRef.current = false;
    pausedRef.current = false;
    for (const controller of abortControllersRef.current.values()) controller.abort();
    abortControllersRef.current.clear();
    revokeAll();
    chunksRef.current = [];
    setChunks([]);
    setPhase("idle");
  }, [revokeAll]);

  /* -------------------------------- the worker ------------------------------ */

  // Ref indirection so processChunk can trigger the latest pump without
  // creating a useCallback dependency cycle.
  const pumpRef = useRef<() => void>(() => {});

  const processChunk = useCallback(
    async (id: number): Promise<void> => {
      const token = runTokenRef.current;
      const chunk = chunksRef.current.find((c) => c.id === id);
      if (!chunk || chunk.status === "ready") return;

      const controller = new AbortController();
      abortControllersRef.current.set(id, controller);
      updateChunk(id, { status: "processing", error: null, attempts: (chunk.attempts ?? 0) + 1 });

      const maxAttempts = 1 + MAX_RETRIES;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const s = settingsRef.current;
          let result: { wav: Blob; duration: number } | null = null;

          if (s.engine === "gemini") {
            if (!s.apiKey) {
              throw new TtsError("Missing Gemini API key. Open Settings and add your key.", false);
            }
            result = await synthesizeWithGemini(
              chunk.text,
              { apiKey: s.apiKey, model: s.model, voice: s.voice },
              controller.signal,
            );
          } else if (s.engine === "kokoro") {
            if (s.kokoroMode === "server") {
              result = await synthesizeWithKokoroServer(
                chunk.text,
                { baseUrl: s.kokoroServerUrl, voice: s.voice, speed: s.speed },
                controller.signal,
              );
            } else {
              // In-browser inference: serialize model access and surface load
              // progress through the chunk's status line.
              result = await synthesizeWithKokoroBrowser(
                chunk.text,
                {
                  voice: s.voice,
                  speed: s.speed,
                  device: s.kokoroDevice,
                  onProgress: ({ stage, ratio }) => {
                    const message =
                      stage === "loading"
                        ? `Loading Kokoro model… ${Math.round(ratio * 100)}% (first run downloads the weights)`
                        : `Synthesizing locally… ${Math.round(ratio * 100)}%`;
                    updateChunk(id, { status: "processing", error: message });
                  },
                },
                controller.signal,
              );
            }
          } else {
            // Web Speech API: zero-cost live synthesis — validation pass only.
            await sleep(50);
            if (token !== runTokenRef.current) return;
            if (typeof window !== "undefined" && !("speechSynthesis" in window)) {
              throw new TtsError("This browser does not support the Web Speech API.", false);
            }
            updateChunk(id, {
              status: "ready",
              audioUrl: null,
              duration: estimateSpeechDuration(chunk.text),
              byteSize: null,
              error: null,
            });
            abortControllersRef.current.delete(id);
            pumpRef.current();
            return;
          }

          if (token !== runTokenRef.current) return; // stale run
          const previousUrl = chunk.audioUrl;
          const audioUrl = createAudioUrl(result.wav);
          if (previousUrl) revokeAudioUrl(previousUrl);
          updateChunk(id, {
            status: "ready",
            audioUrl,
            duration: result.duration,
            byteSize: result.wav.size,
            error: null,
          });
          abortControllersRef.current.delete(id);
          pumpRef.current();
          return;
        } catch (err) {
          abortControllersRef.current.delete(id);
          const aborted =
            controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError");
          if (aborted || token !== runTokenRef.current) {
            // Paused or cancelled: rewind to pending (unless already ready).
            const current = chunksRef.current.find((c) => c.id === id);
            if (current && current.status !== "ready") updateChunk(id, { status: "pending" });
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          const retryable = !(err instanceof TtsError) || err.retryable;

          if (retryable && attempt < maxAttempts) {
            const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 400;
            updateChunk(id, {
              status: "processing",
              error: `${message} — retrying in ${Math.round(backoff / 1000)}s (attempt ${attempt + 1}/${maxAttempts})`,
            });
            await sleep(backoff);
            if (controller.signal.aborted || token !== runTokenRef.current) {
              const current = chunksRef.current.find((c) => c.id === id);
              if (current && current.status !== "ready") updateChunk(id, { status: "pending" });
              return;
            }
            continue;
          }

          updateChunk(id, { status: "error", error: message });
          pumpRef.current();
          return;
        }
      }
    },
    [createAudioUrl, revokeAudioUrl, updateChunk],
  );

  const pump = useCallback((): void => {
    if (!runningRef.current || pausedRef.current) return;

    let active = 0;
    const pendingIds: number[] = [];
    for (const c of chunksRef.current) {
      if (c.status === "processing") active++;
      else if (c.status === "pending") pendingIds.push(c.id);
    }

    let slots = TTS_CONCURRENCY - active;
    for (const id of pendingIds) {
      if (slots <= 0) break;
      slots -= 1;
      void processChunk(id);
    }

    if (pendingIds.length === 0 && active === 0) {
      // Batch finished.
      const all = chunksRef.current;
      runningRef.current = false;
      setPhase("idle");
      onCompleteRef.current?.({
        ready: all.filter((c) => c.status === "ready").length,
        failed: all.filter((c) => c.status === "error").length,
        total: all.length,
      });
    }
  }, [processChunk]);

  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  /* ------------------------------ public controls --------------------------- */

  const start = useCallback((): void => {
    const s = settingsRef.current;
    if (s.engine === "gemini" && !s.apiKey) {
      onNotifyRef.current?.("A Gemini API key is required. Open Settings to add one.", "error");
      return;
    }
    if (s.engine === "kokoro" && s.kokoroMode === "server" && !s.kokoroServerUrl.trim()) {
      onNotifyRef.current?.(
        "A local Kokoro server URL is required (e.g. http://localhost:8880/v1).",
        "error",
      );
      return;
    }
    const hasWork = chunksRef.current.some((c) => c.status === "pending" || c.status === "error");
    if (!hasWork) {
      onNotifyRef.current?.("All chunks are already synthesized.", "info");
      return;
    }
    // Queue failed chunks for another attempt too.
    chunksRef.current = chunksRef.current.map((c) =>
      c.status === "error" ? { ...c, status: "pending", error: null } : c,
    );
    setChunks(chunksRef.current);
    runningRef.current = true;
    pausedRef.current = false;
    runTokenRef.current += 1;
    setPhase("running");
    pumpRef.current();
  }, []);

  const pause = useCallback((): void => {
    if (!runningRef.current) return;
    pausedRef.current = true;
    setPhase("paused");
    // Abort in-flight requests for an immediate pause; their handlers rewind
    // the chunks back to "pending".
    for (const controller of abortControllersRef.current.values()) controller.abort();
    abortControllersRef.current.clear();
  }, []);

  const resume = useCallback((): void => {
    if (!runningRef.current) return;
    pausedRef.current = false;
    setPhase("running");
    pumpRef.current();
  }, []);

  const cancel = useCallback((): void => {
    runningRef.current = false;
    pausedRef.current = false;
    runTokenRef.current += 1;
    for (const controller of abortControllersRef.current.values()) controller.abort();
    abortControllersRef.current.clear();
    chunksRef.current = chunksRef.current.map((c) =>
      c.status === "processing" ? { ...c, status: "pending", error: null } : c,
    );
    setChunks(chunksRef.current);
    setPhase("idle");
  }, []);

  const retryChunk = useCallback((id: number): void => {
    const chunk = chunksRef.current.find((c) => c.id === id);
    if (!chunk || (chunk.status !== "error" && chunk.status !== "pending")) return;

    if (runningRef.current) {
      updateChunk(id, { status: "pending", error: null });
      pumpRef.current();
      return;
    }
    // Targeted single-chunk run: only this chunk is re-queued.
    updateChunk(id, { status: "pending", error: null });
    runningRef.current = true;
    pausedRef.current = false;
    runTokenRef.current += 1;
    setPhase("running");
    void processChunk(id);
  }, [processChunk, updateChunk]);

  const getChunkBlob = useCallback(async (id: number): Promise<Blob | null> => {
    const chunk = chunksRef.current.find((c) => c.id === id);
    if (!chunk?.audioUrl) return null;
    try {
      const res = await fetch(chunk.audioUrl);
      return await res.blob();
    } catch {
      return null;
    }
  }, []);

  /* --------------------------------- stats ---------------------------------- */

  const totalCount = chunks.length;
  const readyCount = chunks.filter((c) => c.status === "ready").length;
  const errorCount = chunks.filter((c) => c.status === "error").length;
  const doneCount = readyCount + errorCount;

  return {
    chunks,
    resetChunks,
    clearAll,
    start,
    pause,
    resume,
    cancel,
    retryChunk,
    phase,
    totalCount,
    readyCount,
    errorCount,
    doneCount,
    getChunkBlob,
  };
}

/** Build chunk state objects from raw manuscript text. */
function chunkTextToChunks(text: string): ManuscriptChunk[] {
  return chunkText(text).map((t, idx) => makeChunk(idx, t));
}
