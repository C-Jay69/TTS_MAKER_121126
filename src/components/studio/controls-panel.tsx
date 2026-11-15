"use client";

/**
 * Voice & engine controls + batch generation controls.
 */

import {
  Bot,
  Cpu,
  ExternalLink,
  KeyRound,
  MonitorSpeaker,
  Pause,
  Play,
  RotateCcw,
  Server,
  Volume2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_KOKORO_SERVER_URL,
  DEFAULT_TTS_MODEL,
  GEMINI_VOICES,
  KOKORO_VOICES,
  PLAYBACK_SPEEDS,
  WEB_SPEECH_FALLBACK_VOICE,
  type EngineKind,
  type KokoroMode,
  type KokoroDevice,
  type TtsSettings,
} from "@/lib/studio/constants";
import { cn } from "@/lib/utils";

export interface SpeechVoiceOption {
  uri: string;
  label: string;
}

interface Props {
  settings: TtsSettings;
  onSettingsChange: (patch: Partial<TtsSettings>) => void;
  speechVoices: SpeechVoiceOption[];
  phase: "idle" | "running" | "paused";
  readyCount: number;
  totalCount: number;
  errorCount: number;
  hasManuscript: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  /** Drop cached audio for this manuscript and start over (e.g. new voice). */
  onRegenerate?: () => void;
}

export function ControlsPanel({
  settings,
  onSettingsChange,
  speechVoices,
  phase,
  readyCount,
  totalCount,
  errorCount,
  hasManuscript,
  onStart,
  onPause,
  onResume,
  onCancel,
  onRegenerate,
}: Props) {
  const [showKey, setShowKey] = useState(false);

  const isGemini = settings.engine === "gemini";
  const isKokoro = settings.engine === "kokoro";
  const isKokoroServer = isKokoro && settings.kokoroMode === "server";
  const busy = phase !== "idle";
  const allDone = totalCount > 0 && readyCount + errorCount === totalCount && readyCount > 0;
  const startBlocked =
    !hasManuscript ||
    (isGemini && !settings.apiKey.trim()) ||
    (isKokoroServer && !settings.kokoroServerUrl.trim());

  return (
    <Card className="border-slate-800 bg-slate-900/60">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-slate-100">
          <Volume2 className="size-4 text-indigo-400" />
          Voice engine
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Engine */}
        <div className="space-y-1.5">
          <Label htmlFor="engine" className="text-xs text-slate-400">
            TTS engine
          </Label>
          <Select
            value={settings.engine}
            onValueChange={(v) => onSettingsChange({ engine: v as EngineKind })}
            disabled={busy}
          >
            <SelectTrigger id="engine" className="w-full border-slate-700 bg-slate-800/60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-slate-700 bg-slate-900">
              <SelectItem value="gemini">
                <span className="flex items-center gap-2">
                  <Bot className="size-3.5 text-indigo-400" /> Gemini TTS (cloud, API key)
                </span>
              </SelectItem>
              <SelectItem value="kokoro">
                <span className="flex items-center gap-2">
                  <Server className="size-3.5 text-emerald-400" /> Local Kokoro (your computer)
                </span>
              </SelectItem>
              <SelectItem value="webspeech">
                <span className="flex items-center gap-2">
                  <MonitorSpeaker className="size-3.5 text-slate-400" /> Web Speech API (free, live)
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isGemini ? (
          <>
            {/* API key */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="api-key" className="text-xs text-slate-400">
                  Gemini API key
                </Label>
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300"
                >
                  Get one free <ExternalLink className="size-3" />
                </a>
              </div>
              <div className="relative">
                <KeyRound className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" />
                <Input
                  id="api-key"
                  type={showKey ? "text" : "password"}
                  value={settings.apiKey}
                  onChange={(e) => onSettingsChange({ apiKey: e.target.value })}
                  placeholder="AIza…"
                  autoComplete="off"
                  spellCheck={false}
                  className="border-slate-700 bg-slate-800/60 pl-8 pr-14 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-slate-400 hover:text-slate-200"
                >
                  {showKey ? "Hide" : "Show"}
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Stored only in this browser (localStorage) and sent directly to Google&apos;s endpoint.
              </p>
            </div>

            {/* Model */}
            <div className="space-y-1.5">
              <Label htmlFor="model" className="text-xs text-slate-400">
                Model
              </Label>
              <Select value={settings.model} onValueChange={(v) => onSettingsChange({ model: v })} disabled={busy}>
                <SelectTrigger id="model" className="w-full border-slate-700 bg-slate-800/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-slate-700 bg-slate-900">
                  <SelectItem value="gemini-2.5-flash-preview-tts">Gemini 2.5 Flash TTS (fast)</SelectItem>
                  <SelectItem value="gemini-2.5-pro-preview-tts">Gemini 2.5 Pro TTS (richer)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Gemini voice */}
            <div className="space-y-1.5">
              <Label htmlFor="voice" className="text-xs text-slate-400">
                Narrator voice
              </Label>
              <Select value={settings.voice} onValueChange={(v) => onSettingsChange({ voice: v })}>
                <SelectTrigger id="voice" className="w-full border-slate-700 bg-slate-800/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72 border-slate-700 bg-slate-900">
                  <SelectGroup>
                    <SelectLabel className="text-slate-500">30 prebuilt voices</SelectLabel>
                    {GEMINI_VOICES.map((v) => (
                      <SelectItem key={v.name} value={v.name}>
                        {v.name} <span className="text-slate-500">· {v.style}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </>
        ) : isKokoro ? (
          <>
            {/* Connection mode */}
            <div className="space-y-1.5">
              <Label htmlFor="kokoro-mode" className="text-xs text-slate-400">
                Where should the model run?
              </Label>
              <Select
                value={settings.kokoroMode}
                onValueChange={(v) => onSettingsChange({ kokoroMode: v as KokoroMode })}
                disabled={busy}
              >
                <SelectTrigger id="kokoro-mode" className="w-full border-slate-700 bg-slate-800/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-slate-700 bg-slate-900">
                  <SelectItem value="server">
                    <span className="flex items-center gap-2">
                      <Server className="size-3.5 text-emerald-400" /> Local server (OpenAI-compatible)
                    </span>
                  </SelectItem>
                  <SelectItem value="browser">
                    <span className="flex items-center gap-2">
                      <Cpu className="size-3.5 text-amber-400" /> In this browser tab (kokoro-js)
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {isKokoroServer ? (
              <div className="space-y-1.5">
                <Label htmlFor="kokoro-url" className="text-xs text-slate-400">
                  Server base URL
                </Label>
                <Input
                  id="kokoro-url"
                  type="url"
                  value={settings.kokoroServerUrl}
                  onChange={(e) => onSettingsChange({ kokoroServerUrl: e.target.value })}
                  placeholder={DEFAULT_KOKORO_SERVER_URL}
                  spellCheck={false}
                  className="border-slate-700 bg-slate-800/60 font-mono text-xs"
                />
                <p className="text-[11px] leading-relaxed text-slate-500">
                  Works with Kokoro-FastAPI (default port 8880), kokoro-onnx servers or any
                  OpenAI-compatible <span className="font-mono">/audio/speech</span> endpoint. Browsers
                  allow HTTPS pages to call <span className="font-mono">http://localhost</span>; the
                  server must permit CORS.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="kokoro-device" className="text-xs text-slate-400">
                  Inference device
                </Label>
                <Select
                  value={settings.kokoroDevice}
                  onValueChange={(v) => onSettingsChange({ kokoroDevice: v as KokoroDevice })}
                  disabled={busy}
                >
                  <SelectTrigger id="kokoro-device" className="w-full border-slate-700 bg-slate-800/60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-slate-700 bg-slate-900">
                    <SelectItem value="auto">Auto (WebGPU if available)</SelectItem>
                    <SelectItem value="webgpu">WebGPU (fast, ~330 MB fp32)</SelectItem>
                    <SelectItem value="wasm">WASM (compatible, ~90 MB q8)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Kokoro voice */}
            <div className="space-y-1.5">
              <Label htmlFor="kokoro-voice" className="text-xs text-slate-400">
                Narrator voice
              </Label>
              <Select value={settings.voice} onValueChange={(v) => onSettingsChange({ voice: v })}>
                <SelectTrigger id="kokoro-voice" className="w-full border-slate-700 bg-slate-800/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72 border-slate-700 bg-slate-900">
                  <SelectGroup>
                    <SelectLabel className="text-slate-500">Kokoro-82M v1.0 voices</SelectLabel>
                    {KOKORO_VOICES.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name} <span className="text-slate-500">· {v.gender} · {v.accent}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <Alert className="border-slate-700/70 bg-slate-800/40">
              {isKokoroServer ? (
                <Server className="size-4 text-emerald-400" />
              ) : (
                <Cpu className="size-4 text-amber-400" />
              )}
              <AlertDescription className="text-xs leading-relaxed text-slate-400">
                {isKokoroServer
                  ? "Your local server synthesizes each chunk and returns a WAV file, so per-chunk downloads and full-audiobook export work."
                  : "Runs the 82M-parameter model right in this tab — nothing leaves your computer. The first run downloads the weights once (cached afterwards); synthesis is slower than a server."}
              </AlertDescription>
            </Alert>
          </>
        ) : (
          <>
            {/* Web Speech voice */}
            <div className="space-y-1.5">
              <Label htmlFor="ws-voice" className="text-xs text-slate-400">
                System voice
              </Label>
              <Select
                value={settings.voice || WEB_SPEECH_FALLBACK_VOICE}
                onValueChange={(v) => onSettingsChange({ voice: v })}
              >
                <SelectTrigger id="ws-voice" className="w-full border-slate-700 bg-slate-800/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72 border-slate-700 bg-slate-900">
                  <SelectItem value={WEB_SPEECH_FALLBACK_VOICE}>Automatic (system default)</SelectItem>
                  {speechVoices.map((v) => (
                    <SelectItem key={v.uri} value={v.uri}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Alert className="border-slate-700/70 bg-slate-800/40">
              <MonitorSpeaker className="size-4 text-slate-400" />
              <AlertDescription className="text-xs leading-relaxed text-slate-400">
                The Web Speech API speaks live through your OS voices — free and instant, but chunks are
                not recorded, so per-chunk files and WAV export need the Gemini engine.
              </AlertDescription>
            </Alert>
          </>
        )}

        {/* Speed */}
        <div className="space-y-1.5">
          <Label htmlFor="speed" className="text-xs text-slate-400">
            Playback speed
          </Label>
          <Select value={String(settings.speed)} onValueChange={(v) => onSettingsChange({ speed: Number(v) })}>
            <SelectTrigger id="speed" className="w-full border-slate-700 bg-slate-800/60">
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
        </div>

        {/* Generation controls */}
        <div className="space-y-2 border-t border-slate-800 pt-4">
          {!busy ? (
            <Button
              onClick={onStart}
              disabled={startBlocked}
              className="w-full gap-2 bg-indigo-500 text-white shadow-lg shadow-indigo-500/25 hover:bg-indigo-400"
            >
              <Play className="size-4" />
              {readyCount > 0 ? "Generate remaining chunks" : "Generate audiobook"}
            </Button>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {phase === "running" ? (
                <Button onClick={onPause} variant="secondary" className="gap-1.5">
                  <Pause className="size-4" /> Pause
                </Button>
              ) : (
                <Button onClick={onResume} className="gap-1.5 bg-indigo-500 hover:bg-indigo-400">
                  <Play className="size-4" /> Resume
                </Button>
              )}
              <Button onClick={onCancel} variant="outline" className="gap-1.5 border-slate-700 hover:bg-slate-800">
                <X className="size-4" /> Cancel
              </Button>
            </div>
          )}

          {onRegenerate && readyCount > 0 && !busy ? (
            <Button
              onClick={onRegenerate}
              variant="ghost"
              size="sm"
              className="w-full gap-1.5 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              <RotateCcw className="size-3" /> Regenerate all (discards cached audio)
            </Button>
          ) : null}

          {totalCount > 0 ? (
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                {readyCount}/{totalCount} ready
                {errorCount > 0 ? ` · ${errorCount} failed` : ""}
              </span>
              {allDone && !busy ? (
                <Badge variant="secondary" className="bg-emerald-500/15 text-[10px] text-emerald-400">
                  Complete
                </Badge>
              ) : phase === "paused" ? (
                <Badge variant="secondary" className="bg-amber-500/15 text-[10px] text-amber-400">
                  Paused
                </Badge>
              ) : null}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** Helper hook: collect available Web Speech voices once they load. */
export function useSpeechVoices(): SpeechVoiceOption[] {
  const [voices, setVoices] = useState<SpeechVoiceOption[]>([]);
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const load = () => {
      const list = window.speechSynthesis
        .getVoices()
        .map((v) => ({ uri: v.voiceURI, label: `${v.name} (${v.lang})` }));
      setVoices(list);
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  return voices;
}
