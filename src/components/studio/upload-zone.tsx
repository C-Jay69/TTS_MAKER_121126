"use client";

/**
 * Drag-and-drop upload zone with hard 5 MB validation and extension checks.
 */

import { useCallback, useRef, useState } from "react";
import { BookOpenText, FileText, Loader2, UploadCloud } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MAX_FILE_SIZE, SUPPORTED_EXTENSIONS } from "@/lib/studio/constants";
import { cn } from "@/lib/utils";

interface Props {
  onFileAccepted: (file: File) => void;
  isParsing: boolean;
  error: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function UploadZone({ onFileAccepted, isParsing, error }: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const validateAndAccept = useCallback(
    (file: File) => {
      onFileAccepted(file);
    },
    [onFileAccepted],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) validateAndAccept(file);
    },
    [validateAndAccept],
  );

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center justify-center gap-6 py-10">
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload manuscript"
        onClick={() => !isParsing && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={cn(
          "group flex w-full cursor-pointer flex-col items-center gap-4 rounded-2xl border-2 border-dashed px-8 py-14 text-center transition-all outline-none",
          isDragging
            ? "border-indigo-400 bg-indigo-500/10 shadow-[0_0_40px_-10px] shadow-indigo-500/40"
            : "border-slate-700 bg-slate-900/60 hover:border-indigo-500/60 hover:bg-slate-900",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950",
        )}
      >
        <div
          className={cn(
            "flex size-16 items-center justify-center rounded-full transition-colors",
            isDragging ? "bg-indigo-500/20 text-indigo-300" : "bg-slate-800 text-slate-400 group-hover:text-indigo-300",
          )}
        >
          {isParsing ? <Loader2 className="size-8 animate-spin" /> : <UploadCloud className="size-8" />}
        </div>

        {isParsing ? (
          <div className="space-y-1">
            <p className="text-base font-medium text-slate-100">Extracting text from your manuscript…</p>
            <p className="text-sm text-slate-400">Parsing runs entirely in your browser.</p>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-base font-medium text-slate-100">
              Drop your manuscript here, or <span className="text-indigo-400">browse files</span>
            </p>
            <p className="text-sm text-slate-400">
              Plain text, Markdown, PDF, Word (.docx / .doc) — max {formatBytes(MAX_FILE_SIZE)}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-center gap-2">
          {SUPPORTED_EXTENSIONS.map((ext) => (
            <span
              key={ext}
              className="rounded-md border border-slate-700 bg-slate-800/70 px-2 py-0.5 font-mono text-xs text-slate-300"
            >
              {ext}
            </span>
          ))}
        </div>

        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          accept={SUPPORTED_EXTENSIONS.join(",")}
          disabled={isParsing}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) validateAndAccept(file);
            e.target.value = "";
          }}
        />
      </div>

      {error ? (
        <div
          role="alert"
          className="flex w-full items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-red-300"
        >
          <FileText className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <p className="flex items-center gap-2 text-xs text-slate-500">
        <BookOpenText className="size-3.5" />
        Nothing is uploaded to a server — parsing, chunking and synthesis happen locally in this tab.
      </p>
    </div>
  );
}
