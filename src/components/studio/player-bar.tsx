"use client";

/**
 * Bottom player bar: transport controls, chunk indicator, seek slider and
 * the "Download Full Audiobook (.wav)" export which stitches all chunk WAVs
 * client-side via their PCM payloads.
 */

import { Download, Loader2, Pause, Play, SkipBack, SkipForward, Waves } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PLAYBACK_SPEEDS, type ManuscriptChunk } from "@/lib/studio/constants";
import { formatDuration, stitchWavs } from "@/lib/studio/wav";
import { cn } from "@/lib/utils";

interface Props {
  chunks: ManuscriptChunk[];
  currentIndex: number | null;
  isPlaying: boolean;
  currentTime: number;
  currentDuration: number;
  speed: number;
  fileName: string;
  onToggle: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (time: number) => void;
  onSpeedChange: (speed: number) => void;
  onNotify: (message: string, kind?: "error" | "info") => void;
  /** Fired after a successful full-book export, for persistence. */
  onExported?: (info: { byteSize: number; duration: number; chunkCount: number }) => void;
}

export function PlayerBar({
  chunks,
  currentIndex,
  isPlaying,
  currentTime,
  currentDuration,
  speed,
  fileName,
  onToggle,
  onNext,
  onPrevious,
  onSeek,
  onSpeedChange,
  onNotify,
  onExported,
}: Props) {
  const [stitching, setStitching] = useState(false);
  const [stitchRatio, setStitchRatio] = useState(0);

  const playableChunks = chunks.filter((c) => c.audioUrl);
  const hasAudio = playableChunks.length > 0;
  const currentChunk = currentIndex !== null ? chunks[currentIndex] : null;
  const isLiveSpeech = currentChunk !== null && !currentChunk.audioUrl;
  const duration = currentDuration > 0 ? currentDuration : currentChunk?.duration || 0;

  const baseName = fileName.replace(/\.[^.]+$/, "") || "audiobook";

  const handleDownloadFull = async (): Promise<void> => {
    if (!hasAudio || stitching) return;
    setStitching(true);
    setStitchRatio(0);
    let mergedUrl: string | null = null;
    try {
      const blobs: Blob[] = [];
      for (let i = 0; i < playableChunks.length; i++) {
        const res = await fetch(playableChunks[i].audioUrl as string);
        blobs.push(await res.blob());
      }
      const merged = await stitchWavs(blobs, (ratio) => setStitchRatio(ratio));
      mergedUrl = URL.createObjectURL(merged);
      const anchor = document.createElement("a");
      anchor.href = mergedUrl;
      anchor.download = `${baseName}-audiobook.wav`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      onNotify(`Audiobook exported (${playableChunks.length} chunks merged).`, "info");
      onExported?.({
        byteSize: merged.size,
        duration: playableChunks.reduce((sum, c) => sum + (c.duration || 0), 0),
        chunkCount: playableChunks.length,
      });
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Failed to stitch the audiobook.", "error");
    } finally {
      // Give the download a moment to start, then free the memory.
      if (mergedUrl) setTimeout(() => URL.revokeObjectURL(mergedUrl as string), 30_000);
      setStitching(false);
      setStitchRatio(0);
    }
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-800 bg-slate-950/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-2.5 sm:px-6">
        {/* Seek row */}
        <div className="flex items-center gap-3">
          <span className="w-12 shrink-0 text-right font-mono text-[11px] text-slate-400">
            {formatDuration(currentTime)}
          </span>
          <Slider
            value={[Math.min(currentTime, duration || currentTime || 0)]}
            max={duration > 0 ? duration : 1}
            step={0.1}
            disabled={!currentChunk?.audioUrl || duration <= 0}
            onValueChange={(v) => onSeek(v[0] ?? 0)}
            aria-label="Seek within chunk"
            className="cursor-pointer [&_[data-slot=slider-range]]:bg-gradient-to-r [&_[data-slot=slider-range]]:from-indigo-500 [&_[data-slot=slider-range]]:to-violet-400"
          />
          <span className="w-12 shrink-0 font-mono text-[11px] text-slate-400">
            {isLiveSpeech && !duration ? "live" : formatDuration(duration)}
          </span>
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                onClick={onPrevious}
                disabled={currentIndex === null || currentIndex <= 0}
                aria-label="Previous chunk"
                className="size-8 text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                <SkipBack className="size-4" />
              </Button>
              <Button
                size="icon"
                onClick={onToggle}
                aria-label={isPlaying ? "Pause" : "Play"}
                className="size-9 rounded-full bg-indigo-500 text-white shadow-md shadow-indigo-500/30 hover:bg-indigo-400"
              >
                {isPlaying ? <Pause className="size-4" /> : <Play className="size-4 translate-x-[1px]" />}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={onNext}
                disabled={currentIndex === null || currentIndex >= chunks.length - 1}
                aria-label="Next chunk"
                className="size-8 text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                <SkipForward className="size-4" />
              </Button>
            </div>

            <div className="min-w-0 text-xs">
              {currentIndex !== null ? (
                <>
                  <p className="truncate font-medium text-slate-200">
                    Chunk {currentIndex + 1} of {chunks.length}
                  </p>
                  <p className="truncate text-slate-500">
                    {isLiveSpeech ? "Live synthesis · Web Speech" : `${chunks[currentIndex].text.length.toLocaleString()} chars`}
                  </p>
                </>
              ) : (
                <p className="truncate text-slate-500">
                  {hasAudio ? "Press play to start the audiobook" : "Synthesized audio will appear here"}
                </p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Select value={String(speed)} onValueChange={(v) => onSpeedChange(Number(v))}>
              <SelectTrigger
                aria-label="Playback speed"
                className="h-8 w-[74px] border-slate-700 bg-slate-800/60 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-slate-700 bg-slate-900">
                {PLAYBACK_SPEEDS.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {s.toFixed(2)}x
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              onClick={handleDownloadFull}
              disabled={!hasAudio || stitching}
              variant="outline"
              className={cn(
                "h-8 gap-1.5 border-indigo-500/40 bg-indigo-500/10 px-3 text-xs text-indigo-200",
                "hover:bg-indigo-500/20 hover:text-indigo-100",
              )}
            >
              {stitching ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Merging {Math.round(stitchRatio * 100)}%
                </>
              ) : (
                <>
                  <Waves className="size-3.5" />
                  <Download className="size-3.5" />
                  <span className="hidden sm:inline">Download Full Audiobook (.wav)</span>
                  <span className="sm:hidden">Export .wav</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
