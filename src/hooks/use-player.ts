"use client";

/**
 * Gapless sequential audio player.
 *
 * Plays synthesized chunks back-to-back: when chunk N ends (`onEnded`), chunk
 * N+1 starts automatically. Chunks without an audio URL (Web Speech engine)
 * are spoken live via SpeechSynthesis with the same chaining semantics.
 * Clicking any chunk jumps playback to it; speed applies instantly.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ManuscriptChunk } from "@/lib/studio/constants";

export interface UsePlayerApi {
  currentIndex: number | null;
  isPlaying: boolean;
  currentTime: number;
  currentDuration: number;
  speed: number;
  playIndex: (index: number) => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  seek: (time: number) => void;
  setSpeed: (speed: number) => void;
  stop: () => void;
}

export function usePlayer(
  chunks: ManuscriptChunk[],
  options?: {
    getSpeechVoice?: () => SpeechSynthesisVoice | null;
    onNotify?: (message: string, kind?: "error" | "info") => void;
  },
): UsePlayerApi {
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [currentDuration, setCurrentDuration] = useState(0);
  const [speed, setSpeedState] = useState(1);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const chunksRef = useRef(chunks);
  const indexRef = useRef<number | null>(null);
  const speedRef = useRef(1);
  const speechVoiceRef = useRef(options?.getSpeechVoice);
  const onNotifyRef = useRef(options?.onNotify);

  useEffect(() => {
    chunksRef.current = chunks;
  }, [chunks]);
  useEffect(() => {
    speechVoiceRef.current = options?.getSpeechVoice;
    onNotifyRef.current = options?.onNotify;
  }, [options?.getSpeechVoice, options?.onNotify]);

  // Ref indirection so speakChunk can trigger the latest advance.
  const advanceRef = useRef<() => void>(() => {});

  /** Speak a chunk live through the Web Speech API. */
  const speakChunk = useCallback((index: number, text: string) => {
    const synth = window.speechSynthesis;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = speechVoiceRef.current?.();
    if (voice) utterance.voice = voice;
    utterance.rate = Math.min(2, Math.max(0.5, speedRef.current));
    utterance.onstart = () => setIsPlaying(true);
    utterance.onboundary = (event) => {
      // Approximate elapsed position from the spoken character index.
      setCurrentTime(event.charIndex / 15);
    };
    utterance.onend = () => {
      if (indexRef.current === index) advanceRef.current();
    };
    utterance.onerror = (event) => {
      if (event.error === "interrupted" || event.error === "canceled") return;
      setIsPlaying(false);
      onNotifyRef.current?.(`Speech synthesis failed: ${event.error}`, "error");
    };
    synth.speak(utterance);
  }, []);

  const playIndexInternal = useCallback(
    async (index: number, { autoplay = true }: { autoplay?: boolean } = {}): Promise<boolean> => {
      const chunk = chunksRef.current[index];
      if (!chunk) return false;
      if (chunk.status !== "ready") {
        onNotifyRef.current?.(
          chunk.status === "error"
            ? `Chunk ${index + 1} failed to synthesize. Retry it first.`
            : `Chunk ${index + 1} is not synthesized yet.`,
          "info",
        );
        return false;
      }

      indexRef.current = index;
      setCurrentIndex(index);
      setCurrentTime(0);
      setCurrentDuration(chunk.duration || 0);

      if (chunk.audioUrl) {
        const audio = audioRef.current;
        if (!audio) return false;
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
        audio.src = chunk.audioUrl;
        audio.playbackRate = speedRef.current;
        if (!autoplay) {
          setIsPlaying(false);
          return true;
        }
        try {
          await audio.play();
        } catch {
          setIsPlaying(false);
          onNotifyRef.current?.("Playback was blocked by the browser. Press play to start.", "info");
        }
      } else if ("speechSynthesis" in window) {
        if (!autoplay) {
          setIsPlaying(false);
          return true;
        }
        speakChunk(index, chunk.text);
      }
      return true;
    },
    [speakChunk],
  );

  const advance = useCallback((): void => {
    const idx = indexRef.current;
    if (idx === null) return;
    const nextIndex = idx + 1;
    if (nextIndex < chunksRef.current.length) {
      // Auto-continue with the next chunk (gapless chaining).
      void playIndexInternal(nextIndex);
    } else {
      // End of the manuscript.
      indexRef.current = null;
      setCurrentIndex(null);
      setIsPlaying(false);
      setCurrentTime(0);
    }
  }, [playIndexInternal]);

  useEffect(() => {
    advanceRef.current = advance;
  }, [advance]);

  /* --------------------------- audio element wiring -------------------------- */

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "auto";
    audioRef.current = audio;

    const onEnded = () => advanceRef.current();
    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      if (Number.isFinite(audio.duration) && audio.duration > 0) setCurrentDuration(audio.duration);
    };
    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setCurrentDuration(audio.duration);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onError = () => {
      if (!audio.src) return;
      setIsPlaying(false);
      onNotifyRef.current?.("Audio playback error on this chunk.", "error");
    };

    audio.addEventListener("ended", onEnded);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("error", onError);

    return () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("error", onError);
      audio.pause();
      audio.src = "";
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);

  /* ------------------------------- public API ------------------------------- */

  const playIndex = useCallback(
    (index: number) => {
      void playIndexInternal(index);
    },
    [playIndexInternal],
  );

  const toggle = useCallback((): void => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;

    if (isPlaying) {
      audioRef.current?.pause();
      if (synth) synth.pause();
      setIsPlaying(false);
      return;
    }

    if (indexRef.current === null) {
      // Start from the first ready chunk.
      const firstReady = chunksRef.current.findIndex((c) => c.status === "ready");
      if (firstReady === -1) {
        onNotifyRef.current?.("Nothing to play yet — generate the audiobook first.", "info");
        return;
      }
      void playIndexInternal(firstReady);
      return;
    }

    const chunk = chunksRef.current[indexRef.current];
    if (!chunk) return;

    if (chunk.audioUrl && audioRef.current) {
      void audioRef.current.play().catch(() => setIsPlaying(false));
    } else if (synth) {
      if (synth.paused && synth.speaking) {
        synth.resume();
        setIsPlaying(true);
      } else {
        speakChunk(indexRef.current, chunk.text);
      }
    }
  }, [isPlaying, playIndexInternal, speakChunk]);

  const next = useCallback((): void => {
    const idx = indexRef.current;
    const target = idx === null ? 0 : Math.min(idx + 1, chunksRef.current.length - 1);
    if (idx !== null && target === idx) return;
    void playIndexInternal(target);
  }, [playIndexInternal]);

  const previous = useCallback((): void => {
    const idx = indexRef.current;
    if (idx === null) return;
    void playIndexInternal(Math.max(0, idx - 1));
  }, [playIndexInternal]);

  const seek = useCallback((time: number): void => {
    const chunk = indexRef.current !== null ? chunksRef.current[indexRef.current] : null;
    if (chunk?.audioUrl && audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
  }, []);

  const setSpeed = useCallback((value: number): void => {
    speedRef.current = value;
    setSpeedState(value);
    if (audioRef.current) audioRef.current.playbackRate = value;
    // Web Speech picks the new rate up on the next spoken chunk.
  }, []);

  const stop = useCallback((): void => {
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    indexRef.current = null;
    setCurrentIndex(null);
    setIsPlaying(false);
    setCurrentTime(0);
  }, []);

  return {
    currentIndex,
    isPlaying,
    currentTime,
    currentDuration,
    speed,
    playIndex,
    toggle,
    next,
    previous,
    seek,
    setSpeed,
    stop,
  };
}
