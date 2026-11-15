/**
 * Durable cache for generated chunk audio.
 *
 * A batch can be interrupted by a browser reload, a tab crash, or the TTS
 * server being killed mid-run. Audio blobs normally live only as object URLs
 * in memory, so all of that work would be lost. Every finished chunk is
 * mirrored into IndexedDB here instead, keyed by a fingerprint of the
 * manuscript plus the chunk index, which lets the studio restore finished
 * chunks and offer a genuine "continue" after the interruption.
 *
 * This is browser-local by design: no credentials are needed and nothing is
 * uploaded. IndexedDB is unavailable in some private modes, so every call
 * degrades to a no-op rather than breaking generation.
 */

import type { EngineKind } from "./constants";

const DB_NAME = "audiobook-studio";
const DB_VERSION = 1;
const STORE = "chunk-audio";
const INDEX = "manuscriptKey";

export interface StoredChunkAudio {
  /** `${manuscriptKey}:${index}` */
  key: string;
  manuscriptKey: string;
  index: number;
  /** Fingerprint of the chunk text, used to reject stale/misaligned entries. */
  textHash: number;
  blob: Blob;
  duration: number;
  engine: EngineKind;
  voice: string;
  createdAt: number;
}

export interface ChunkAudioInput {
  manuscriptKey: string;
  index: number;
  text: string;
  blob: Blob;
  duration: number;
  engine: EngineKind;
  voice: string;
}

/** FNV-1a, 32-bit. Fast, synchronous, and good enough for cache identity. */
export function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Stable identity for a manuscript. Length is folded in so that two documents
 * with the same 32-bit hash but different sizes do not share cached audio.
 */
export function manuscriptFingerprint(text: string): string {
  return `${hashText(text).toString(16).padStart(8, "0")}-${text.length.toString(36)}`;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex(INDEX, "manuscriptKey", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** True when audio can be cached in this browser right now. */
export async function audioCacheAvailable(): Promise<boolean> {
  return (await openDb()) !== null;
}

/**
 * Mirror one finished chunk. Resolves false when storage is unavailable or
 * full — generation continues regardless.
 */
export async function saveChunkAudio(input: ChunkAudioInput): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;

  const record: StoredChunkAudio = {
    key: `${input.manuscriptKey}:${input.index}`,
    manuscriptKey: input.manuscriptKey,
    index: input.index,
    textHash: hashText(input.text),
    blob: input.blob,
    duration: input.duration,
    engine: input.engine,
    voice: input.voice,
    createdAt: Date.now(),
  };

  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    await txDone(tx);
    return true;
  } catch {
    return false;
  }
}

/** Every cached chunk for a manuscript, in index order. */
export async function loadManuscriptAudio(manuscriptKey: string): Promise<StoredChunkAudio[]> {
  const db = await openDb();
  if (!db) return [];

  try {
    const tx = db.transaction(STORE, "readonly");
    const index = tx.objectStore(STORE).index(INDEX);
    const request = index.getAll(manuscriptKey);
    const rows = await new Promise<StoredChunkAudio[]>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as StoredChunkAudio[]) ?? []);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    });
    await txDone(tx);
    return rows
      .filter((row) => row?.blob instanceof Blob)
      .sort((a, b) => a.index - b.index);
  } catch {
    return [];
  }
}

/** Forget the cached audio for a manuscript (used by "Clear"). */
export async function deleteManuscriptAudio(manuscriptKey: string): Promise<void> {
  const db = await openDb();
  if (!db) return;

  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const keysRequest = store.index(INDEX).getAllKeys(manuscriptKey);
    keysRequest.onsuccess = () => {
      for (const key of keysRequest.result) store.delete(key);
    };
    await txDone(tx);
  } catch {
    /* best effort */
  }
}
