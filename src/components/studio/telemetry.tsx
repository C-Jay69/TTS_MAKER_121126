"use client";

/**
 * Real-time telemetry dashboard: word count, estimated reading time,
 * chunk count and overall synthesis progress.
 */

import { Clock3, Layers, ProgressCheck, Type } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import { formatDuration } from "@/lib/studio/wav";
import { cn } from "@/lib/utils";

interface Props {
  wordCount: number;
  readingTimeSeconds: number;
  totalChunks: number;
  readyCount: number;
  errorCount: number;
  synthesizedSeconds: number;
  processingCount: number;
}

export function Telemetry({
  wordCount,
  readingTimeSeconds,
  totalChunks,
  readyCount,
  errorCount,
  synthesizedSeconds,
  processingCount,
}: Props) {
  const percent = totalChunks > 0 ? Math.round((readyCount / totalChunks) * 100) : 0;
  const estimatedMinutes = Math.max(1, Math.round(readingTimeSeconds / 60));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={<Type className="size-4" />}
          label="Total words"
          value={wordCount.toLocaleString()}
        />
        <StatCard
          icon={<Clock3 className="size-4" />}
          label="Est. reading time"
          value={`~${estimatedMinutes} min`}
        />
        <StatCard
          icon={<Layers className="size-4" />}
          label="Audio chunks"
          value={totalChunks.toLocaleString()}
        />
        <StatCard
          icon={<ProgressCheck className="size-4" />}
          label="Audio ready"
          value={`${formatDuration(synthesizedSeconds)}${synthesizedSeconds > 0 ? "" : ""}`}
          sub={`${readyCount}/${totalChunks} chunks`}
        />
      </div>

      <Card className="border-slate-800 bg-slate-900/60">
        <CardContent className="space-y-2 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-slate-200">Synthesis progress</span>
            <span className="flex items-center gap-3 text-xs text-slate-400">
              {processingCount > 0 ? (
                <span className="flex items-center gap-1.5 text-indigo-300">
                  <span className="size-1.5 animate-pulse rounded-full bg-indigo-400" />
                  {processingCount} synthesizing…
                </span>
              ) : null}
              {errorCount > 0 ? <span className="text-red-400">{errorCount} failed</span> : null}
              <span className="font-mono text-slate-300">
                {readyCount} / {totalChunks} chunks
              </span>
            </span>
          </div>
          <Progress
            value={percent}
            className="h-2.5 bg-slate-800 [&>div]:bg-gradient-to-r [&>div]:from-indigo-500 [&>div]:to-violet-400"
          />
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card className="border-slate-800 bg-slate-900/60">
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-400">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs text-slate-400">{label}</p>
          <p className={cn("truncate text-lg font-semibold text-slate-100")}>{value}</p>
          {sub ? <p className="text-[11px] text-slate-500">{sub}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
