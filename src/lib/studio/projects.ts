/**
 * Shared project/persistence types and request schemas.
 *
 * This module is imported by both the browser and the route handlers, so it
 * must stay free of server-only imports (no Prisma here).
 */

import { z } from "zod";

import type { ChunkStatus, EngineKind } from "./constants";

/* ------------------------------ request schemas ----------------------------- */

export const engineSchema = z.enum(["gemini", "webspeech", "kokoro"]);
export const chunkStatusSchema = z.enum(["pending", "processing", "ready", "error"]);

export const projectSettingsSchema = z.object({
  engine: engineSchema,
  voice: z.string().min(1).max(200),
  model: z.string().max(200).nullable().optional(),
  speed: z.number().min(0.5).max(3),
});

export const projectChunkSchema = z.object({
  index: z.number().int().min(0).max(100_000),
  text: z.string().min(1).max(20_000),
  status: chunkStatusSchema,
  duration: z.number().min(0).max(86_400).nullable().optional(),
  byteSize: z.number().int().min(0).max(200_000_000).nullable().optional(),
  error: z.string().max(2_000).nullable().optional(),
  attempts: z.number().int().min(0).max(100).optional(),
});

export const projectDraftSchema = z.object({
  /** Display name. Defaults to the file name minus extension on the client. */
  name: z.string().trim().min(1).max(200),
  sourceName: z.string().max(500).nullable().optional(),
  sourceSize: z.number().int().min(0).max(50_000_000).nullable().optional(),
  /** Full parsed manuscript. The 5 MB upload cap means text stays well under this. */
  manuscript: z.string().min(1).max(20_000_000),
  wordCount: z.number().int().min(0).max(20_000_000),
  settings: projectSettingsSchema,
  chunks: z.array(projectChunkSchema).max(5_000),
});

export const audioAssetSchema = z.object({
  chunkIndex: z.number().int().min(0).max(100_000).nullable().optional(),
  kind: z.enum(["chunk", "full"]),
  mimeType: z.string().max(100).optional(),
  byteSize: z.number().int().min(0).max(500_000_000),
  duration: z.number().min(0).max(86_400),
  sampleRate: z.number().int().min(8_000).max(192_000).optional(),
  channels: z.number().int().min(1).max(8).optional(),
  engine: engineSchema,
  voice: z.string().min(1).max(200),
});

export type ProjectDraft = z.infer<typeof projectDraftSchema>;
export type ProjectChunkInput = z.infer<typeof projectChunkSchema>;
export type AudioAssetInput = z.infer<typeof audioAssetSchema>;

/* -------------------------------- API shapes -------------------------------- */

export interface ProjectSettingsSnapshot {
  engine: EngineKind;
  voice: string;
  model: string | null;
  speed: number;
}

export interface ProjectChunkRecord {
  id: string;
  index: number;
  text: string;
  status: ChunkStatus;
  duration: number | null;
  byteSize: number | null;
  error: string | null;
  attempts: number;
  updatedAt: string;
}

export interface AudioAssetRecord {
  id: string;
  kind: "chunk" | "full";
  mimeType: string;
  byteSize: number;
  duration: number;
  sampleRate: number;
  channels: number;
  engine: EngineKind;
  voice: string;
  storage: "browser" | "supabase";
  storagePath: string | null;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  sourceName: string | null;
  wordCount: number;
  engine: EngineKind;
  voice: string;
  chunkCount: number;
  readyCount: number;
  errorCount: number;
  durationSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  sourceSize: number | null;
  manuscript: string;
  settings: ProjectSettingsSnapshot;
  chunks: ProjectChunkRecord[];
  exports: AudioAssetRecord[];
}

/* ------------------------------- client helpers ----------------------------- */

export class ProjectApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProjectApiError";
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      /* non-JSON error page */
    }
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Request failed (${response.status})`;
    throw new ProjectApiError(message, response.status);
  }
  return payload as T;
}

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const response = await fetch("/api/projects", { cache: "no-store" });
  const data = await parseResponse<{ projects: ProjectSummary[] }>(response);
  return data.projects;
}

export async function fetchProject(id: string): Promise<ProjectDetail> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { cache: "no-store" });
  const data = await parseResponse<{ project: ProjectDetail }>(response);
  return data.project;
}

export async function createProject(draft: ProjectDraft): Promise<ProjectDetail> {
  const response = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  const data = await parseResponse<{ project: ProjectDetail }>(response);
  return data.project;
}

export async function updateProject(id: string, draft: ProjectDraft): Promise<ProjectDetail> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  const data = await parseResponse<{ project: ProjectDetail }>(response);
  return data.project;
}

export async function deleteProject(id: string): Promise<void> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
  await parseResponse<unknown>(response);
}

export async function recordAudioAsset(id: string, asset: AudioAssetInput): Promise<void> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(asset),
  });
  await parseResponse<unknown>(response);
}

/** Turn any thrown value from the helpers above into a human message. */
export function projectErrorMessage(error: unknown): string {
  if (error instanceof ProjectApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Unexpected error talking to the project API.";
}
