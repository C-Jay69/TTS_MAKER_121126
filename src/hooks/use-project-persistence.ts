"use client";

/**
 * Project persistence: list / save / load / delete against the Postgres-backed
 * API, plus the "auto-save after a batch finishes" behaviour.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  createProject,
  deleteProject,
  fetchProject,
  fetchProjects,
  projectErrorMessage,
  updateProject,
  type ProjectDetail,
  type ProjectDraft,
  type ProjectSummary,
} from "@/lib/studio/projects";

type Notify = (message: string, kind?: "error" | "info") => void;

export interface ProjectPersistenceOptions {
  /** Build the current snapshot under a display name. Null when there is nothing to save. */
  getDraft: (name: string) => ProjectDraft | null;
  /** Restore a project into the studio UI. */
  onLoaded: (detail: ProjectDetail) => void;
  onNotify: Notify;
}

export interface ProjectPersistenceApi {
  projects: ProjectSummary[];
  loading: boolean;
  saving: boolean;
  busyId: string | null;
  currentId: string | null;
  currentName: string | null;
  lastSavedAt: string | null;
  refresh: () => Promise<void>;
  load: (id: string) => Promise<void>;
  saveNew: (name: string) => Promise<ProjectDetail | null>;
  saveCurrent: (options?: { silent?: boolean; name?: string }) => Promise<ProjectDetail | null>;
  rename: (name: string) => void;
  remove: (id: string) => Promise<void>;
  reset: () => void;
}

export function useProjectPersistence({
  getDraft,
  onLoaded,
  onNotify,
}: ProjectPersistenceOptions): ProjectPersistenceApi {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentName, setCurrentName] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  // Keep the latest callbacks without re-creating the public API on each render.
  const getDraftRef = useRef(getDraft);
  const onNotifyRef = useRef(onNotify);
  useEffect(() => {
    getDraftRef.current = getDraft;
    onNotifyRef.current = onNotify;
  }, [getDraft, onNotify]);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setProjects(await fetchProjects());
    } catch (error) {
      onNotifyRef.current(projectErrorMessage(error), "error");
    } finally {
      setLoading(false);
    }
  }, []);

  const load = useCallback(
    async (id: string): Promise<void> => {
      setBusyId(id);
      try {
        const detail = await fetchProject(id);
        onLoaded(detail);
        setCurrentId(detail.id);
        setCurrentName(detail.name);
        setLastSavedAt(detail.updatedAt);
        onNotifyRef.current(
          `Loaded "${detail.name}". Audio is not stored in the database — press Generate to rebuild it.`,
          "info",
        );
      } catch (error) {
        onNotifyRef.current(projectErrorMessage(error), "error");
      } finally {
        setBusyId(null);
      }
    },
    [onLoaded],
  );

  const saveNew = useCallback(
    async (name: string): Promise<ProjectDetail | null> => {
      const draft = getDraftRef.current(name);
      if (!draft) {
        onNotifyRef.current("Load a manuscript before saving a project.", "error");
        return null;
      }
      setSaving(true);
      try {
        const detail = await createProject(draft);
        setCurrentId(detail.id);
        setCurrentName(detail.name);
        setLastSavedAt(detail.updatedAt);
        await refresh();
        onNotifyRef.current(`Saved "${detail.name}" to Postgres.`, "info");
        return detail;
      } catch (error) {
        onNotifyRef.current(projectErrorMessage(error), "error");
        return null;
      } finally {
        setSaving(false);
      }
    },
    [refresh],
  );

  const saveCurrent = useCallback(
    async (options?: { silent?: boolean; name?: string }): Promise<ProjectDetail | null> => {
      if (!currentId) {
        if (!options?.silent) onNotifyRef.current("This project has not been saved yet.", "error");
        return null;
      }
      const draft = getDraftRef.current(options?.name?.trim() || currentName || "Untitled project");
      if (!draft) return null;

      setSaving(true);
      try {
        const detail = await updateProject(currentId, draft);
        setCurrentName(detail.name);
        setLastSavedAt(detail.updatedAt);
        setProjects((prev) =>
          prev.map((project) =>
            project.id === detail.id
              ? {
                  ...project,
                  name: detail.name,
                  wordCount: detail.wordCount,
                  chunkCount: detail.chunkCount,
                  readyCount: detail.readyCount,
                  errorCount: detail.errorCount,
                  durationSeconds: detail.durationSeconds,
                  updatedAt: detail.updatedAt,
                }
              : project,
          ),
        );
        if (!options?.silent) onNotifyRef.current(`Saved "${detail.name}".`, "info");
        return detail;
      } catch (error) {
        onNotifyRef.current(projectErrorMessage(error), "error");
        return null;
      } finally {
        setSaving(false);
      }
    },
    [currentId, currentName],
  );

  const rename = useCallback((name: string): void => {
    setCurrentName(name);
  }, []);

  const remove = useCallback(
    async (id: string): Promise<void> => {
      setBusyId(id);
      try {
        await deleteProject(id);
        setProjects((prev) => prev.filter((project) => project.id !== id));
        if (currentId === id) {
          setCurrentId(null);
          setCurrentName(null);
          setLastSavedAt(null);
        }
        onNotifyRef.current("Project deleted.", "info");
      } catch (error) {
        onNotifyRef.current(projectErrorMessage(error), "error");
      } finally {
        setBusyId(null);
      }
    },
    [currentId],
  );

  const reset = useCallback((): void => {
    setCurrentId(null);
    setCurrentName(null);
    setLastSavedAt(null);
  }, []);

  return {
    projects,
    loading,
    saving,
    busyId,
    currentId,
    currentName,
    lastSavedAt,
    refresh,
    load,
    saveNew,
    saveCurrent,
    rename,
    remove,
    reset,
  };
}
