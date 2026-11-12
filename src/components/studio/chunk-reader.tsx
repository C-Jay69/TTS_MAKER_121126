"use client";

/**
 * Interactive script view: scrollable reader pane that highlights the chunk
 * currently being played, auto-scrolls to keep it visible, and lets the user
 * click any chunk to jump playback there. Each chunk exposes play / download
 * / retry actions depending on its state.
 */

import { useEffect, useRef } from "react";
import {
  AlertCircle,
  Download,
  FileText,
  Loader2,
  Play,
  RotateCcw,
  CheckCircle2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ManuscriptChunk } from "@/lib/studio/constants";
import { formatDuration } from "@/lib/studio/wav";
import { cn } from "@/lib/utils";

interface Props {
  fileName: string;
  chunks: ManuscriptChunk[];
  currentIndex: number | null;
  onPlayChunk: (index: number) => void;
  onDownloadChunk: (chunk: ManuscriptChunk) => void;
  onRetryChunk: (id: number) => void;
}

const STATUS_META: Record<
  ManuscriptChunk["status"],
  { label: string; dot: string; text: string }
> = {
  pending: { label: "Pending", dot: "bg-slate-500", text: "text-slate-400" },
  processing: { label: "Synthesizing", dot: "bg-indigo-400 animate-pulse", text: "text-indigo-300" },
  ready: { label: "Ready", dot: "bg-emerald-400", text: "text-emerald-300" },
  error: { label: "Failed", dot: "bg-red-400", text: "text-red-300" },
};

export function ChunkReader({
  fileName,
  chunks,
  currentIndex,
  onPlayChunk,
  onDownloadChunk,
  onRetryChunk,
}: Props) {
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Auto-scroll: keep the playing chunk in view.
  useEffect(() => {
    if (currentIndex === null) return;
    itemRefs.current[currentIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [currentIndex]);

  return (
    <Card className="border-slate-800 bg-slate-900/60">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <FileText className="size-4 shrink-0 text-indigo-400" />
            <span className="truncate font-medium text-slate-200">{fileName}</span>
          </div>
          <span className="shrink-0 text-[11px] text-slate-500">
            Click a section to jump playback there
          </span>
        </div>

        <ScrollArea className="h-[52vh] min-h-[320px] rounded-lg border border-slate-800/80 bg-slate-950/60">
          <div className="space-y-2 p-3 studio-scroll">
            {chunks.map((chunk, index) => (
              <ChunkCard
                key={chunk.id}
                chunk={chunk}
                index={index}
                active={currentIndex === index}
                registerRef={(el) => {
                  itemRefs.current[index] = el;
                }}
                onPlay={() => onPlayChunk(index)}
                onDownload={() => onDownloadChunk(chunk)}
                onRetry={() => onRetryChunk(chunk.id)}
              />
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function ChunkCard({
  chunk,
  index,
  active,
  registerRef,
  onPlay,
  onDownload,
  onRetry,
}: {
  chunk: ManuscriptChunk;
  index: number;
  active: boolean;
  registerRef: (el: HTMLDivElement | null) => void;
  onPlay: () => void;
  onDownload: () => void;
  onRetry: () => void;
}) {
  const meta = STATUS_META[chunk.status];
  const canPlay = chunk.status === "ready";

  return (
    <div
      ref={registerRef}
      role="button"
      tabIndex={0}
      aria-current={active ? "true" : undefined}
      aria-label={`Chunk ${index + 1}`}
      onClick={() => canPlay && onPlay()}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && canPlay) {
          e.preventDefault();
          onPlay();
        }
      }}
      className={cn(
        "group cursor-pointer rounded-xl border p-3 transition-all outline-none",
        active
          ? "border-indigo-400/70 bg-indigo-500/10 shadow-[0_0_25px_-8px] shadow-indigo-500/50"
          : "border-slate-800 bg-slate-900/50 hover:border-slate-600 hover:bg-slate-800/50",
        "focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg font-mono text-xs",
            active ? "bg-indigo-500 text-white" : "bg-slate-800 text-slate-400 group-hover:text-slate-200",
          )}
        >
          {chunk.status === "processing" ? <Loader2 className="size-3.5 animate-spin text-indigo-300" /> : index + 1}
        </div>

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span className={cn("flex items-center gap-1.5 font-medium", meta.text)}>
              <span className={cn("size-1.5 rounded-full", meta.dot)} />
              {meta.label}
            </span>
            <span className="text-slate-600">·</span>
            <span className="text-slate-500">{chunk.text.length.toLocaleString()} chars</span>
            {chunk.status === "ready" && chunk.duration > 0 ? (
              <>
                <span className="text-slate-600">·</span>
                <span className="text-slate-500">~{formatDuration(chunk.duration)}</span>
              </>
            ) : null}
          </div>

          <p
            className={cn(
              "whitespace-pre-wrap text-[13px] leading-relaxed",
              active ? "line-clamp-none text-slate-100" : "line-clamp-2 text-slate-400",
            )}
          >
            {chunk.text}
          </p>

          {chunk.status === "processing" && chunk.error ? (
            <div className="flex items-start gap-1.5 rounded-md bg-indigo-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-indigo-200">
              <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin" />
              <span>{chunk.error}</span>
            </div>
          ) : null}

          {chunk.status === "error" && chunk.error ? (
            <div className="flex items-start gap-1.5 rounded-md bg-red-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-red-300">
              <AlertCircle className="mt-0.5 size-3 shrink-0" />
              <span>{chunk.error}</span>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {canPlay ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label={active ? "Playing" : `Play chunk ${index + 1}`}
              onClick={(e) => {
                e.stopPropagation();
                onPlay();
              }}
              className={cn(
                "size-7",
                active
                  ? "bg-indigo-500/20 text-indigo-200"
                  : "text-slate-400 opacity-0 hover:bg-slate-700 hover:text-slate-100 group-hover:opacity-100",
              )}
            >
              {active ? <CheckCircle2 className="size-3.5" /> : <Play className="size-3.5" />}
            </Button>
          ) : null}

          {chunk.status === "error" ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Retry chunk ${index + 1}`}
              onClick={(e) => {
                e.stopPropagation();
                onRetry();
              }}
              className="size-7 text-amber-400 hover:bg-amber-500/15 hover:text-amber-300"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          ) : null}

          {chunk.audioUrl ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Download chunk ${index + 1}`}
              onClick={(e) => {
                e.stopPropagation();
                onDownload();
              }}
              className="size-7 text-slate-400 opacity-0 hover:bg-slate-700 hover:text-slate-100 group-hover:opacity-100"
            >
              <Download className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
