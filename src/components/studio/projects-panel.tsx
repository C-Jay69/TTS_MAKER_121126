"use client";

/**
 * Projects dialog — save the current manuscript + chunk snapshot to Postgres,
 * reopen a saved project, or delete one.
 *
 * Audio bytes are never uploaded: only metadata (duration, byte size, engine,
 * voice) is persisted, so a reloaded project needs to be regenerated.
 */

import { useState } from "react";
import {
  Clock3,
  CopyPlus,
  Database,
  FolderOpen,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { ProjectPersistenceApi } from "@/hooks/use-project-persistence";
import { formatDuration } from "@/lib/studio/wav";
import { cn } from "@/lib/utils";

interface Props {
  persistence: ProjectPersistenceApi;
  hasManuscript: boolean;
  suggestedName: string;
}

function formatTimestamp(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}

export function ProjectsPanel({ persistence, hasManuscript, suggestedName }: Props) {
  const [open, setOpen] = useState(false);
  // null means "not edited yet" — fall back to the project / suggested name.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const { currentId, currentName, saving, busyId, projects } = persistence;

  const effectiveName = nameDraft ?? currentName ?? suggestedName;

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    if (next) {
      // Reset the edit buffer and pull a fresh list, as an event rather than
      // an effect so opening the dialog never cascades a render.
      setNameDraft(null);
      void persistence.refresh();
    }
  };

  const canSave = hasManuscript && effectiveName.trim().length > 0 && !saving;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 text-xs text-slate-300 hover:bg-slate-800"
        >
          <Database className="size-3.5" />
          <span className="hidden sm:inline">Projects</span>
        </Button>
      </DialogTrigger>

      <DialogContent className="max-h-[85vh] border-slate-800 bg-slate-950 text-slate-200 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-slate-100">
            <Database className="size-4 text-indigo-400" /> Projects
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Manuscripts, chunks and audio metadata are stored in Supabase Postgres. Audio itself
            stays in this browser, so a reopened project must be regenerated.
          </DialogDescription>
        </DialogHeader>

        {/* Current project */}
        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/60 p-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="project-name" className="text-xs text-slate-400">
              {currentId ? "Project name" : "Save as"}
            </Label>
            {currentId ? (
              <Badge variant="secondary" className="gap-1 text-[10px]">
                <Clock3 className="size-3" />
                {persistence.lastSavedAt ? formatTimestamp(persistence.lastSavedAt) : "unsaved"}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] text-slate-500">
                not saved yet
              </Badge>
            )}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="project-name"
              value={effectiveName}
              onChange={(event) => setNameDraft(event.target.value)}
              placeholder="My audiobook"
              disabled={!hasManuscript || saving}
              className="border-slate-700 bg-slate-800/60 text-sm"
              maxLength={200}
            />
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                onClick={() => void persistence.saveCurrent({ name: effectiveName })}
                disabled={!currentId || !canSave}
                className="gap-1.5 bg-indigo-600 hover:bg-indigo-500"
              >
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void persistence.saveNew(effectiveName.trim())}
                disabled={!canSave}
                className="gap-1.5 border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
              >
                <CopyPlus className="size-3.5" /> Save as new
              </Button>
            </div>
          </div>

          {!currentId ? (
            <p className="text-[11px] leading-relaxed text-slate-500">
              Saving creates a new project row. Later saves update it in place.
            </p>
          ) : null}
          {!hasManuscript ? (
            <p className="text-[11px] text-amber-300/80">
              Load or upload a manuscript to enable saving.
            </p>
          ) : null}
        </div>

        <Separator className="bg-slate-800" />

        {/* Saved projects */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Saved projects
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void persistence.refresh()}
              disabled={persistence.loading}
              className="h-7 gap-1.5 px-2 text-[11px] text-slate-400 hover:bg-slate-800"
            >
              <RefreshCw className={cn("size-3", persistence.loading && "animate-spin")} /> Refresh
            </Button>
          </div>

          <ScrollArea className="max-h-64 pr-2">
            {projects.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">
                {persistence.loading ? "Loading…" : "No saved projects yet."}
              </p>
            ) : (
              <ul className="space-y-2">
                {projects.map((project) => {
                  const isCurrent = project.id === currentId;
                  const isBusy = busyId === project.id;
                  return (
                    <li
                      key={project.id}
                      className={cn(
                        "flex items-start justify-between gap-3 rounded-md border px-3 py-2",
                        isCurrent
                          ? "border-indigo-500/40 bg-indigo-500/5"
                          : "border-slate-800 bg-slate-900/40",
                      )}
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-slate-100">
                            {project.name}
                          </span>
                          {isCurrent ? (
                            <Badge className="bg-indigo-500/20 text-[10px] text-indigo-300">
                              current
                            </Badge>
                          ) : null}
                        </div>
                        <p className="truncate text-[11px] text-slate-500">
                          {project.wordCount.toLocaleString()} words · {project.chunkCount} chunks ·{" "}
                          {project.readyCount} ready
                          {project.durationSeconds > 0
                            ? ` · ${formatDuration(project.durationSeconds)}`
                            : ""}
                        </p>
                        <p className="text-[10px] text-slate-600">
                          {project.engine} · {project.voice} · {formatTimestamp(project.updatedAt)}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setNameDraft(null);
                            void persistence.load(project.id);
                          }}
                          disabled={isBusy}
                          className="h-7 gap-1 px-2 text-[11px] text-slate-300 hover:bg-slate-800"
                        >
                          {isBusy ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <FolderOpen className="size-3" />
                          )}
                          Load
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteTarget({ id: project.id, name: project.name })}
                          disabled={isBusy}
                          className="h-7 px-2 text-slate-500 hover:bg-red-500/10 hover:text-red-300"
                          aria-label={`Delete ${project.name}`}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>
        </div>

        <DialogFooter className="text-[11px] text-slate-600">
          <span>
            {currentId ? "Changes save to the current project." : "No project selected."}
          </span>
        </DialogFooter>
      </DialogContent>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent className="border-slate-800 bg-slate-950 text-slate-200">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-slate-100">Delete this project?</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              “{deleteTarget?.name}” and all of its chunk and audio metadata will be permanently
              removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) void persistence.remove(deleteTarget.id);
                setDeleteTarget(null);
              }}
              className="bg-red-600 text-white hover:bg-red-500"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
