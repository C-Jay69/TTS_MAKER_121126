/**
 * Server-side persistence for projects. Imported only by route handlers.
 */

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type {
  AudioAssetInput,
  AudioAssetRecord,
  ProjectChunkRecord,
  ProjectDetail,
  ProjectDraft,
  ProjectSummary,
} from "@/lib/studio/projects";

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project ${id} was not found.`);
    this.name = "ProjectNotFoundError";
  }
}

const summarySelect = {
  id: true,
  name: true,
  sourceName: true,
  wordCount: true,
  engine: true,
  voice: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProjectSelect;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/* --------------------------------- listing --------------------------------- */

export async function listProjects(): Promise<ProjectSummary[]> {
  const [projects, counts, durations] = await Promise.all([
    db.project.findMany({ orderBy: { updatedAt: "desc" }, take: 200, select: summarySelect }),
    db.chunk.groupBy({ by: ["projectId", "status"], _count: { _all: true } }),
    db.chunk.groupBy({
      by: ["projectId"],
      where: { status: "ready" },
      _sum: { duration: true },
    }),
  ]);

  const byProject = new Map<string, { chunkCount: number; readyCount: number; errorCount: number }>();
  for (const row of counts) {
    const entry = byProject.get(row.projectId) ?? { chunkCount: 0, readyCount: 0, errorCount: 0 };
    const n = row._count._all;
    entry.chunkCount += n;
    if (row.status === "ready") entry.readyCount += n;
    if (row.status === "error") entry.errorCount += n;
    byProject.set(row.projectId, entry);
  }

  const durationByProject = new Map<string, number>();
  for (const row of durations) {
    durationByProject.set(row.projectId, row._sum.duration ?? 0);
  }

  return projects.map((project) => {
    const stats = byProject.get(project.id) ?? { chunkCount: 0, readyCount: 0, errorCount: 0 };
    return {
      id: project.id,
      name: project.name,
      sourceName: project.sourceName,
      wordCount: project.wordCount,
      engine: project.engine as ProjectSummary["engine"],
      voice: project.voice,
      chunkCount: stats.chunkCount,
      readyCount: stats.readyCount,
      errorCount: stats.errorCount,
      durationSeconds: durationByProject.get(project.id) ?? 0,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
  });
}

/* -------------------------------- retrieval -------------------------------- */

export async function getProject(id: string): Promise<ProjectDetail> {
  const project = await db.project.findUnique({
    where: { id },
    include: {
      chunks: {
        orderBy: { index: "asc" },
        select: {
          id: true,
          index: true,
          text: true,
          status: true,
          duration: true,
          byteSize: true,
          error: true,
          attempts: true,
          updatedAt: true,
        },
      },
      exports: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });

  if (!project) throw new ProjectNotFoundError(id);

  const chunks: ProjectChunkRecord[] = project.chunks.map((chunk) => ({
    id: chunk.id,
    index: chunk.index,
    text: chunk.text,
    status: chunk.status as ProjectChunkRecord["status"],
    duration: chunk.duration,
    byteSize: chunk.byteSize,
    error: chunk.error,
    attempts: chunk.attempts,
    updatedAt: chunk.updatedAt.toISOString(),
  }));

  const exports: AudioAssetRecord[] = project.exports.map((asset) => ({
    id: asset.id,
    kind: asset.kind as AudioAssetRecord["kind"],
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    duration: asset.duration,
    sampleRate: asset.sampleRate,
    channels: asset.channels,
    engine: asset.engine as AudioAssetRecord["engine"],
    voice: asset.voice,
    storage: asset.storage as AudioAssetRecord["storage"],
    storagePath: asset.storagePath,
    createdAt: asset.createdAt.toISOString(),
  }));

  return {
    id: project.id,
    name: project.name,
    sourceName: project.sourceName,
    sourceSize: project.sourceSize,
    wordCount: project.wordCount,
    engine: project.engine as ProjectDetail["engine"],
    voice: project.voice,
    chunkCount: chunks.length,
    readyCount: chunks.filter((c) => c.status === "ready").length,
    errorCount: chunks.filter((c) => c.status === "error").length,
    durationSeconds: chunks.reduce((sum, c) => sum + (c.status === "ready" ? (c.duration ?? 0) : 0), 0),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    manuscript: project.manuscript,
    settings: {
      engine: project.engine as ProjectDetail["engine"],
      voice: project.voice,
      model: project.model,
      speed: project.speed,
    },
    chunks,
    exports,
  };
}

/* --------------------------------- mutation -------------------------------- */

function projectScalars(draft: ProjectDraft) {
  return {
    name: draft.name,
    sourceName: draft.sourceName ?? null,
    sourceSize: draft.sourceSize ?? null,
    manuscript: draft.manuscript,
    wordCount: draft.wordCount,
    engine: draft.settings.engine,
    voice: draft.settings.voice,
    model: draft.settings.model ?? null,
    speed: draft.settings.speed,
  };
}

function chunkData(draft: ProjectDraft) {
  return draft.chunks.map((chunk) => ({
    index: chunk.index,
    text: chunk.text,
    status: chunk.status,
    duration: chunk.duration ?? null,
    byteSize: chunk.byteSize ?? null,
    error: chunk.error ?? null,
    attempts: chunk.attempts ?? 0,
  }));
}

export async function createProject(draft: ProjectDraft): Promise<ProjectDetail> {
  const project = await db.project.create({
    data: {
      ...projectScalars(draft),
      chunks: { createMany: { data: chunkData(draft) } },
    },
    select: { id: true },
  });
  return getProject(project.id);
}

export async function updateProject(id: string, draft: ProjectDraft): Promise<ProjectDetail> {
  const exists = await db.project.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new ProjectNotFoundError(id);

  try {
    await db.$transaction(
      async (tx) => {
        await tx.project.update({
          where: { id },
          data: { ...projectScalars(draft), updatedAt: new Date() },
        });

        // Drop chunks that no longer exist in the new snapshot. Their audio
        // assets survive with chunkId set to null (onDelete: SetNull).
        await tx.chunk.deleteMany({
          where: { projectId: id, index: { gte: draft.chunks.length } },
        });

        for (const chunk of chunkData(draft)) {
          await tx.chunk.upsert({
            where: { projectId_index: { projectId: id, index: chunk.index } },
            create: { projectId: id, ...chunk },
            update: chunk,
          });
        }
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Two saves raced on the same chunk index; the retry-safe answer is a
      // conflict so the client re-fetches rather than silently losing a write.
      throw new ProjectConflictError(id);
    }
    throw error;
  }

  return getProject(id);
}

export class ProjectConflictError extends Error {
  constructor(id: string) {
    super(`Project ${id} was modified concurrently. Reload it and try again.`);
    this.name = "ProjectConflictError";
  }
}

export async function deleteProject(id: string): Promise<void> {
  try {
    await db.project.delete({ where: { id } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new ProjectNotFoundError(id);
    }
    throw error;
  }
}

export async function recordAudioAsset(projectId: string, asset: AudioAssetInput): Promise<void> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) throw new ProjectNotFoundError(projectId);

  let chunkId: string | null = null;
  if (asset.kind === "chunk" && asset.chunkIndex != null) {
    const chunk = await db.chunk.findUnique({
      where: { projectId_index: { projectId, index: asset.chunkIndex } },
      select: { id: true },
    });
    chunkId = chunk?.id ?? null;
  }

  await db.audioAsset.create({
    data: {
      projectId,
      chunkId,
      kind: asset.kind,
      mimeType: asset.mimeType ?? "audio/wav",
      byteSize: asset.byteSize,
      duration: asset.duration,
      sampleRate: asset.sampleRate ?? 24_000,
      channels: asset.channels ?? 1,
      engine: asset.engine,
      voice: asset.voice,
      storage: "browser",
    },
  });
}
