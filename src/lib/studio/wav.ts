/**
 * WAV utilities: PCM -> WAV encoding, header parsing, base64 decoding,
 * and in-browser assembly of a downloadable audiobook.
 *
 * A full-book WAV is far larger than a tab should buffer, so the export path
 * composes the file from headers plus slice views of the existing chunk blobs
 * (see buildAudiobookBlob) and lets the browser stream it to disk. The
 * copying stitcher remains for small inputs.
 */

import { MAX_STITCH_BYTES } from "./constants";

/** Standard RIFF/WAVE header size. */
const WAV_HEADER_BYTES = 44;

/** Enough to cover a normal header plus any metadata chunks an encoder adds. */
const HEADER_PROBE_BYTES = 64 * 1024;

export interface WavMeta {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Byte offset of the PCM payload inside the file. */
  dataOffset: number;
  /** Byte length of the PCM payload. */
  dataLength: number;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Write a canonical 44-byte RIFF/WAVE header for 16-bit PCM. */
function writeWavHeader(
  view: DataView,
  dataLength: number,
  sampleRate: number,
  channels: number,
  bitsPerSample = 16,
): void {
  const blockAlign = channels * (bitsPerSample / 8);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);
}

/**
 * Wrap raw 16-bit PCM bytes in a standard 44-byte RIFF/WAVE header.
 */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels = 1, bitsPerSample = 16): ArrayBuffer {
  const out = new Uint8Array(WAV_HEADER_BYTES + pcm.length);
  writeWavHeader(new DataView(out.buffer), pcm.length, sampleRate, channels, bitsPerSample);
  out.set(pcm, WAV_HEADER_BYTES);
  return out.buffer;
}

/**
 * Parse a RIFF/WAVE file: locate `fmt ` and `data` chunks robustly
 * (skips any metadata chunks such as LIST/FACT that some encoders emit).
 *
 * `trustDeclaredDataLength` is for parsing a truncated header probe: the
 * payload length is taken from the `data` chunk header instead of being
 * clamped to the bytes actually present.
 */
export function parseWavHeader(
  buffer: ArrayBuffer,
  options?: { trustDeclaredDataLength?: boolean },
): WavMeta {
  const view = new DataView(buffer);
  if (buffer.byteLength < 44) throw new Error("File too small to be a WAV");
  if (view.getUint32(0, false) !== 0x52494646 /* RIFF */ || view.getUint32(8, false) !== 0x57415645 /* WAVE */) {
    throw new Error("Not a RIFF/WAVE file");
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 0x666d7420 /* fmt */) {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === 0x64617461 /* data */) {
      dataOffset = offset + 8;
      dataLength = options?.trustDeclaredDataLength
        ? chunkSize
        : Math.min(chunkSize, buffer.byteLength - dataOffset);
    }
    offset += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
    if (chunkSize === 0 && chunkId !== 0x64617461) offset += 1; // guard against infinite loops
  }

  if (!sampleRate || dataOffset < 0) throw new Error("Malformed WAV: missing fmt/data chunk");
  return { sampleRate, channels, bitsPerSample, dataOffset, dataLength };
}

/**
 * Fast, allocation-light base64 -> bytes decoder.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Header metadata for a whole set of chunks, discovered once up front. */
export interface WavSet {
  metas: WavMeta[];
  /** Sum of every chunk's PCM payload. */
  totalData: number;
  sampleRate: number;
  channels: number;
}

/**
 * Read just enough of a blob to locate its `fmt `/`data` headers. Falls back
 * to a full read for the rare file whose `data` chunk sits beyond the probe.
 */
async function readWavMeta(blob: Blob): Promise<WavMeta> {
  const probe = blob.slice(0, Math.min(HEADER_PROBE_BYTES, blob.size));
  try {
    return parseWavHeader(await probe.arrayBuffer(), { trustDeclaredDataLength: true });
  } catch {
    return parseWavHeader(await blob.arrayBuffer());
  }
}

/**
 * Inspect every chunk's header once. Only headers are read, so this stays
 * cheap even for a book with hundreds of chunks.
 */
export async function analyzeWavs(
  blobs: Blob[],
  onProgress?: (ratio: number) => void,
): Promise<WavSet> {
  if (blobs.length === 0) throw new Error("No audio chunks to stitch");

  const metas: WavMeta[] = [];
  let totalData = 0;

  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i];
    const meta = await readWavMeta(blob);
    // A truncated probe can over-report the payload; never plan past the file.
    meta.dataLength = Math.min(meta.dataLength, Math.max(0, blob.size - meta.dataOffset));
    metas.push(meta);
    totalData += meta.dataLength;
    onProgress?.((i + 1) / blobs.length);
  }

  const first = metas[0];
  if (metas.some((m) => m.bitsPerSample !== 16)) {
    throw new Error("Only 16-bit PCM chunks are supported for stitching");
  }
  const mismatched = metas.find((m) => m.sampleRate !== first.sampleRate || m.channels !== first.channels);
  if (mismatched) {
    throw new Error(
      `Mixed audio formats detected (${first.sampleRate} Hz vs ${mismatched.sampleRate} Hz). ` +
        "Regenerate the audiobook with a single engine/voice and try again.",
    );
  }

  return { metas, totalData, sampleRate: first.sampleRate, channels: first.channels };
}

/**
 * Copy chunks [start, end) into one WAV. Each source payload is read, copied
 * into the output buffer and released again, so peak memory is the output
 * part plus a single chunk.
 */
async function stitchRange(
  blobs: Blob[],
  set: WavSet,
  start: number,
  end: number,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  let dataBytes = 0;
  for (let i = start; i < end; i++) dataBytes += set.metas[i].dataLength;

  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  writeWavHeader(new DataView(out.buffer), dataBytes, set.sampleRate, set.channels);

  let cursor = WAV_HEADER_BYTES;
  const count = end - start;
  for (let i = start; i < end; i++) {
    const meta = set.metas[i];
    const buffer = await blobs[i].arrayBuffer();
    out.set(new Uint8Array(buffer, meta.dataOffset, meta.dataLength), cursor);
    cursor += meta.dataLength;
    onProgress?.((i + 1 - start) / count);
  }

  return new Blob([out.buffer], { type: "audio/wav" });
}

/**
 * Merge an ordered list of WAV blobs into a single WAV file.
 *
 * All chunks produced by this app share the same PCM format (16-bit mono),
 * so the PCM payloads are concatenated directly — no re-encoding. This path
 * copies the PCM into a fresh buffer, so it refuses books above
 * MAX_STITCH_BYTES; the export uses buildAudiobookBlob instead, which
 * references the chunk blobs rather than copying them.
 */
export async function stitchWavs(
  blobs: Blob[],
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const set = await analyzeWavs(blobs, onProgress ? (ratio) => onProgress(ratio * 0.5) : undefined);

  if (set.totalData > MAX_STITCH_BYTES) {
    throw new Error(
      `Combined audio is too large to copy into one buffer (~${Math.round(set.totalData / 1024 / 1024)} MB). ` +
        "Use buildAudiobookBlob for a full-book export.",
    );
  }

  return stitchRange(blobs, set, 0, blobs.length, onProgress ? (ratio) => onProgress(0.5 + ratio * 0.5) : undefined);
}

/**
 * Compose the whole audiobook as one WAV file without copying the PCM.
 *
 * A Blob built from other Blobs (and slices of them) keeps references to its
 * segments — the browser only walks them while it streams the download to
 * disk. So a multi-hour book costs a few hundred segment descriptors instead
 * of a gigabyte-sized buffer, which is what makes a full-book export possible
 * in a memory-tight tab.
 *
 * WAV stores its sizes in 32-bit fields, so this is limited to 4 GB of PCM
 * (about 24 hours at 24 kHz mono).
 */
export async function buildAudiobookBlob(
  blobs: Blob[],
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const set = await analyzeWavs(blobs, onProgress);

  if (WAV_HEADER_BYTES + set.totalData > 0xffffffff) {
    throw new Error(
      "This audiobook is too long for a single WAV file (the format tops out at 4 GB). " +
        "Split the manuscript into two projects.",
    );
  }

  const header = new Uint8Array(WAV_HEADER_BYTES);
  writeWavHeader(new DataView(header.buffer), set.totalData, set.sampleRate, set.channels);

  const parts: BlobPart[] = [header];
  for (let i = 0; i < blobs.length; i++) {
    const meta = set.metas[i];
    // Header + PCM only. slice() is a reference, never a copy.
    parts.push(blobs[i].slice(meta.dataOffset, meta.dataOffset + meta.dataLength));
  }

  onProgress?.(1);
  return new Blob(parts, { type: "audio/wav" });
}

/** Format seconds as m:ss (or h:mm:ss for long books). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
