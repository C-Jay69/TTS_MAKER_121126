"use client";

/**
 * Audiobook Studio — main orchestrator.
 *
 * Wires the upload/parsing layer, the smart chunker (via the queue hook),
 * the TTS queue worker, the gapless player and the export pipeline together.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, RefreshCcw, Sparkles, Trash2 } from "lucide-react";

import { ChunkReader } from "@/components/studio/chunk-reader";
import { ControlsPanel, useSpeechVoices } from "@/components/studio/controls-panel";
import { PlayerBar } from "@/components/studio/player-bar";
import { ProjectsPanel } from "@/components/studio/projects-panel";
import { Telemetry } from "@/components/studio/telemetry";
import { UploadZone } from "@/components/studio/upload-zone";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { usePlayer } from "@/hooks/use-player";
import { useProjectPersistence } from "@/hooks/use-project-persistence";
import { useTtsQueue } from "@/hooks/use-tts-queue";
import {
  DEFAULT_SETTINGS,
  ENGINE_DEFAULT_VOICE,
  MAX_FILE_SIZE,
  WEB_SPEECH_FALLBACK_VOICE,
  type ManuscriptChunk,
  type ParseResult,
  type TtsSettings,
} from "@/lib/studio/constants";
import { DEMO_MANUSCRIPT } from "@/lib/studio/demo";
import {
  deleteManuscriptAudio,
  loadManuscriptAudio,
  manuscriptFingerprint,
} from "@/lib/studio/audioStore";
import { countWords, estimateReadingSeconds } from "@/lib/studio/chunker";
import { getFileExtension, isSupportedFile, parseManuscriptFile } from "@/lib/studio/parsers";
import {
  recordAudioAsset,
  type ProjectDetail,
  type ProjectDraft,
} from "@/lib/studio/projects";

interface Manuscript {
  name: string;
  size: number;
  text: string;
}

const SETTINGS_STORAGE = "audiobook-studio.settings";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function Studio() {
  const { toast } = useToast();
  const speechVoices = useSpeechVoices();

  const [manuscript, setManuscript] = useState<Manuscript | null>(null);
  const [parsing, setParsing] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [settings, setSettings] = useState<TtsSettings>(DEFAULT_SETTINGS);
  const settingsLoadedRef = useRef(false);
  /** Stable fingerprint of the current manuscript, used as the audio cache key. */
  const [manuscriptKey, setManuscriptKey] = useState<string | null>(null);

  const notify = useCallback(
    (message: string, kind: "error" | "info" = "info") => {
      toast({
        title: kind === "error" ? "Something went wrong" : "Audiobook Studio",
        description: message,
        variant: kind === "error" ? "destructive" : "default",
      });
    },
    [toast],
  );

  const queue = useTtsQueue(settings, {
    onNotify: notify,
    onComplete: (summary) => {
      notify(
        summary.failed > 0
          ? `Generation finished: ${summary.ready}/${summary.total} chunks ready, ${summary.failed} failed. Use the retry buttons to try again.`
          : `Audiobook generation complete (${summary.total} chunks). Press play and enjoy!`,
      );
    },
    cache: manuscriptKey ? { manuscriptKey } : null,
  });

  const getSpeechVoice = useCallback((): SpeechSynthesisVoice | null => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
    if (!settings.voice || settings.voice === WEB_SPEECH_FALLBACK_VOICE) return null;
    return window.speechSynthesis.getVoices().find((v) => v.voiceURI === settings.voice) ?? null;
  }, [settings.voice]);

  const player = usePlayer(queue.chunks, { getSpeechVoice, onNotify: notify });

  /* ---------------------------- persisted settings --------------------------- */

  // Load once from localStorage (merged over defaults for forward-compat).
  useEffect(() => {
    if (settingsLoadedRef.current) return;
    settingsLoadedRef.current = true;
    try {
      const raw = window.localStorage.getItem(SETTINGS_STORAGE);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<TtsSettings>;
      setSettings((s) => ({ ...s, ...parsed }));
    } catch {
      /* storage unavailable or malformed */
    }
  }, []);

  const handleSettingsChange = useCallback((patch: Partial<TtsSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      // Switching engines: reset the voice to that engine's default so the
      // stored value never points at another engine's voice namespace.
      if (patch.engine && patch.engine !== prev.engine) {
        next.voice = ENGINE_DEFAULT_VOICE[patch.engine];
      }
      try {
        window.localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    player.setSpeed(settings.speed);
  }, [settings.speed]);

  /* -------------------------------- ingestion ------------------------------- */

  // Pull any audio this browser already generated for this exact manuscript.
  // This is what makes "continue where you left off" work after a reload, a
  // tab crash, or the TTS server being killed halfway through a batch.
  const restoreCachedAudio = useCallback(
    async (key: string) => {
      try {
        const stored = await loadManuscriptAudio(key);
        if (stored.length === 0) return;
        const restored = queue.restoreChunks(
          stored.map((row) => ({
            index: row.index,
            textHash: row.textHash,
            blob: row.blob,
            duration: row.duration,
          })),
        );
        if (restored > 0) {
          notify(
            `Restored ${restored} finished chunk${restored === 1 ? "" : "s"} from this browser — press “Generate remaining chunks” to continue.`,
            "info",
          );
        }
      } catch {
        /* cache is best-effort; ignore failures */
      }
    },
    [notify, queue],
  );

  const applyParsedText = useCallback(
    (name: string, size: number, result: ParseResult) => {
      if (!result.text.trim()) {
        setUploadError("No readable text could be extracted from this file.");
        setManuscript(null);
        setManuscriptKey(null);
        return;
      }
      player.stop();
      queue.resetChunks(result.text);
      setManuscript({ name, size, text: result.text });
      setWarnings(result.warnings);
      setUploadError(null);

      const key = manuscriptFingerprint(result.text);
      setManuscriptKey(key);
      void restoreCachedAudio(key);
    },
    [player, queue, restoreCachedAudio],
  );

  /* ------------------------------ project storage ---------------------------- */

  const suggestedProjectName = useMemo(() => {
    if (!manuscript) return "Untitled project";
    return manuscript.name.replace(/\.[^.]+$/, "") || "Untitled project";
  }, [manuscript]);

  // Snapshot exactly what the queue and settings know right now. Audio blobs
  // are deliberately left out — only their metadata is persisted.
  const buildProjectDraft = useCallback(
    (name: string): ProjectDraft | null => {
      if (!manuscript || queue.chunks.length === 0) return null;
      return {
        name: name.trim() || suggestedProjectName,
        sourceName: manuscript.name,
        sourceSize: manuscript.size,
        manuscript: manuscript.text,
        wordCount: countWords(manuscript.text),
        settings: {
          engine: settings.engine,
          voice: settings.voice,
          model: settings.model,
          speed: settings.speed,
        },
        chunks: queue.chunks.map((chunk) => ({
          index: chunk.id,
          text: chunk.text,
          status: chunk.status,
          duration: chunk.duration > 0 ? chunk.duration : null,
          byteSize: chunk.byteSize ?? null,
          error: chunk.error ?? null,
          attempts: chunk.attempts ?? 0,
        })),
      };
    },
    [manuscript, queue.chunks, settings, suggestedProjectName],
  );

  const handleProjectLoaded = useCallback(
    (detail: ProjectDetail) => {
      player.stop();
      applyParsedText(detail.sourceName ?? `${detail.name}.txt`, detail.sourceSize ?? 0, {
        text: detail.manuscript,
        warnings: [],
      });
      setSettings((prev) => ({
        ...prev,
        engine: detail.settings.engine,
        voice: detail.settings.voice,
        model: detail.settings.model ?? prev.model,
        speed: detail.settings.speed,
      }));
    },
    [applyParsedText, player],
  );

  const persistence = useProjectPersistence({
    getDraft: buildProjectDraft,
    onLoaded: handleProjectLoaded,
    onNotify: notify,
  });

  // Once a batch stops — finished or paused because the engine vanished —
  // write the snapshot back to the current project.
  useEffect(() => {
    if (!persistence.currentId) return;
    if (queue.phase !== "idle" && queue.phase !== "paused") return;
    if (queue.readyCount === 0) return;
    const timer = setTimeout(() => {
      void persistence.saveCurrent({ silent: true });
    }, 1500);
    return () => clearTimeout(timer);
  }, [persistence.currentId, persistence.saveCurrent, queue.phase, queue.readyCount]);

  const handleFileAccepted = useCallback(
    async (file: File) => {
      setUploadError(null);
      setWarnings([]);

      if (file.size > MAX_FILE_SIZE) {
        setUploadError(
          `"${file.name}" is ${formatBytes(file.size)}, which exceeds the 5 MB limit. Please split the file or compress it and try again.`,
        );
        return;
      }
      if (!isSupportedFile(file.name)) {
        setUploadError(
          `Unsupported file type "${getFileExtension(file.name) || file.name}". Supported: .txt, .md, .docx, .pdf, .doc.`,
        );
        return;
      }

      setParsing(true);
      try {
        const result = await parseManuscriptFile(file);
        // A fresh upload is a new manuscript, not an edit of the open project.
        persistence.reset();
        applyParsedText(file.name, file.size, result);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : `Could not parse "${file.name}".`);
        setManuscript(null);
      } finally {
        setParsing(false);
      }
    },
    [applyParsedText, persistence.reset],
  );

  const loadDemo = useCallback(() => {
    persistence.reset();
    applyParsedText("sample-manuscript.txt", DEMO_MANUSCRIPT.length, {
      text: DEMO_MANUSCRIPT,
      warnings: [],
    });
  }, [applyParsedText, persistence.reset]);

  const handleClearAll = useCallback(() => {
    player.stop();
    queue.clearAll();
    persistence.reset();
    setManuscriptKey(null);
    setManuscript(null);
    setWarnings([]);
    setUploadError(null);
  }, [player, queue, persistence.reset]);

  /* --------------------------------- actions -------------------------------- */

  const handleDownloadChunk = useCallback(
    (chunk: ManuscriptChunk) => {
      if (!chunk.audioUrl) return;
      const base = (manuscript?.name ?? "audiobook").replace(/\.[^.]+$/, "");
      const anchor = document.createElement("a");
      anchor.href = chunk.audioUrl;
      anchor.download = `${base}-chunk-${String(chunk.id + 1).padStart(3, "0")}.wav`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    },
    [manuscript?.name],
  );

  // Throw away cached audio for this manuscript (after switching voice, for
  // instance) so the next Generate rebuilds every chunk with current settings.
  const handleRegenerateAll = useCallback(() => {
    if (!manuscript) return;
    player.stop();
    if (manuscriptKey) void deleteManuscriptAudio(manuscriptKey);
    queue.resetChunks(manuscript.text);
    notify("Cached audio cleared — press Generate to rebuild every chunk.", "info");
  }, [manuscript, manuscriptKey, notify, player, queue]);

  // Record the metadata of a full-book export against the open project.
  const handleAudioExported = useCallback(
    (info: { byteSize: number; duration: number; chunkCount: number }) => {
      if (!persistence.currentId) return;
      void recordAudioAsset(persistence.currentId, {
        kind: "full",
        byteSize: info.byteSize,
        duration: info.duration,
        engine: settings.engine,
        voice: settings.voice,
        sampleRate: 24_000,
        channels: 1,
      });
    },
    [persistence.currentId, settings.engine, settings.voice],
  );

  /* --------------------------------- derived -------------------------------- */
  const stats = useMemo(() => {
    const words = manuscript ? countWords(manuscript.text) : 0;
    return {
      words,
      readingTime: estimateReadingSeconds(words),
      processingCount: queue.chunks.filter((c) => c.status === "processing").length,
      synthesizedSeconds: queue.chunks.reduce((acc, c) => acc + (c.status === "ready" ? c.duration : 0), 0),
    };
  }, [manuscript, queue.chunks]);

  const hasManuscript = manuscript !== null && queue.totalCount > 0;

  /* ---------------------------------- render -------------------------------- */

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-200 selection:bg-indigo-500/40">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-indigo-500/20">
              <Sparkles className="size-4 text-indigo-400" />
            </div>
            <div className="min-w-0 leading-tight">
              <h1 className="whitespace-nowrap text-sm font-semibold tracking-wide text-slate-100">
                Audiobook Studio
              </h1>
              <p className="hidden truncate text-[11px] text-slate-500 sm:block">
                Manuscript to spoken audio, entirely in your browser
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ProjectsPanel
              persistence={persistence}
              hasManuscript={manuscript !== null}
              suggestedName={suggestedProjectName}
            />
            {manuscript ? (
              <>
                <span className="hidden max-w-[220px] truncate rounded-md border border-slate-800 bg-slate-900 px-2.5 py-1 text-xs text-slate-400 lg:inline-block">
                  {manuscript.name} · {formatBytes(manuscript.size)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => document.getElementById("studio-file-input")?.click()}
                  disabled={parsing}
                  className="h-8 gap-1.5 text-xs text-slate-300 hover:bg-slate-800"
                >
                  <RefreshCcw className="size-3.5" />{" "}
                  <span className="hidden sm:inline">Change file</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleClearAll}
                  className="h-8 gap-1.5 text-xs text-slate-400 hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="size-3.5" /> <span className="hidden sm:inline">Clear</span>
                </Button>
                {/* Hidden input reachable from the header button */}
                <input
                  id="studio-file-input"
                  type="file"
                  className="sr-only"
                  accept=".txt,.md,.markdown,.docx,.pdf,.doc"
                  disabled={parsing}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleFileAccepted(file);
                    e.target.value = "";
                  }}
                />
              </>
            ) : null}
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-36 sm:px-6">
        {!hasManuscript ? (
          <>
            <UploadZone
              onFileAccepted={(file) => void handleFileAccepted(file)}
              isParsing={parsing}
              error={uploadError}
            />
            <div className="flex justify-center pb-6">
              <Button
                variant="ghost"
                onClick={loadDemo}
                className="h-8 gap-1.5 text-xs text-indigo-400 hover:bg-indigo-500/10 hover:text-indigo-300"
              >
                <Sparkles className="size-3.5" /> Or try it with a sample manuscript
              </Button>
            </div>
          </>
        ) : (
          <div className="grid gap-4 py-6 lg:grid-cols-[340px_minmax(0,1fr)]">
            <aside className="space-y-4">
              <ControlsPanel
                settings={settings}
                onSettingsChange={handleSettingsChange}
                speechVoices={speechVoices}
                phase={queue.phase}
                readyCount={queue.readyCount}
                totalCount={queue.totalCount}
                errorCount={queue.errorCount}
                hasManuscript={hasManuscript}
                onStart={queue.start}
                onPause={queue.pause}
                onResume={queue.resume}
                onCancel={queue.cancel}
                onRegenerate={handleRegenerateAll}
              />
            </aside>

            <section className="min-w-0 space-y-4" aria-label="Manuscript">
              {uploadError ? (
                <div
                  role="alert"
                  className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-red-300"
                >
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>{uploadError}</span>
                </div>
              ) : null}
              <Telemetry
                wordCount={stats.words}
                readingTimeSeconds={stats.readingTime}
                totalChunks={queue.totalCount}
                readyCount={queue.readyCount}
                errorCount={queue.errorCount}
                synthesizedSeconds={stats.synthesizedSeconds}
                processingCount={stats.processingCount}
              />

              {warnings.length > 0 ? (
                <div
                  role="status"
                  className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
                >
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
                  <div className="space-y-1">
                    {warnings.map((w, i) => (
                      <p key={i} className="leading-relaxed">
                        {w}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}

              <ChunkReader
                fileName={manuscript?.name ?? "manuscript"}
                chunks={queue.chunks}
                currentIndex={player.currentIndex}
                onPlayChunk={player.playIndex}
                onDownloadChunk={handleDownloadChunk}
                onRetryChunk={queue.retryChunk}
              />
            </section>
          </div>
        )}
      </main>

      {/* Player */}
      {queue.totalCount > 0 ? (
        <PlayerBar
          chunks={queue.chunks}
          currentIndex={player.currentIndex}
          isPlaying={player.isPlaying}
          currentTime={player.currentTime}
          currentDuration={player.currentDuration}
          speed={player.speed}
          fileName={manuscript?.name ?? "audiobook"}
          onToggle={player.toggle}
          onNext={player.next}
          onPrevious={player.previous}
          onSeek={player.seek}
          onSpeedChange={player.setSpeed}
          onNotify={notify}
          onExported={handleAudioExported}
        />
      ) : null}
    </div>
  );
}
