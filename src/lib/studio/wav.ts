/**
 * WAV utilities: PCM -> WAV encoding, header parsing, base64 decoding,
 * and in-browser stitching of chunk WAVs into one downloadable audiobook.
 */

import { MAX_STITCH_BYTES } from "./constants";

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

/**
 * Wrap raw 16-bit PCM bytes in a standard 44-byte RIFF/WAVE header.
 */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels = 1, bitsPerSample = 16): ArrayBuffer {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);

  return out.buffer;
}

/**
 * Parse a RIFF/WAVE file: locate `fmt ` and `data` chunks robustly
 * (skips any metadata chunks such as LIST/FACT that some encoders emit).
 */
export function parseWavHeader(buffer: ArrayBuffer): WavMeta {
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
      dataLength = Math.min(chunkSize, buffer.byteLength - dataOffset);
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

/**
 * Merge an ordered list of WAV blobs into a single WAV file.
 *
 * All chunks produced by this app share the same PCM format (16-bit mono),
 * so the PCM payloads are concatenated directly — no re-encoding, minimal
 * memory overhead. Header metadata is validated for consistency first.
 */
export async function stitchWavs(
  blobs: Blob[],
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  if (blobs.length === 0) throw new Error("No audio chunks to stitch");

  const buffers: ArrayBuffer[] = [];
  const metas: WavMeta[] = [];
  let totalData = 0;

  for (let i = 0; i < blobs.length; i++) {
    const ab = await blobs[i].arrayBuffer();
    const meta = parseWavHeader(ab);
    if (meta.bitsPerSample !== 16) throw new Error("Only 16-bit PCM chunks are supported for stitching");
    buffers.push(ab);
    metas.push(meta);
    totalData += meta.dataLength;
    onProgress?.(((i + 1) / blobs.length) * 0.5);
  }

  const first = metas[0];
  const mismatched = metas.find((m) => m.sampleRate !== first.sampleRate || m.channels !== first.channels);
  if (mismatched) {
    throw new Error(
      `Mixed audio formats detected (${first.sampleRate} Hz vs ${mismatched.sampleRate} Hz). ` +
        "Regenerate the audiobook with a single engine/voice and try again.",
    );
  }

  if (totalData > MAX_STITCH_BYTES) {
    throw new Error(
      `Combined audiobook is too large to stitch in the browser (~${Math.round(totalData / 1024 / 1024)} MB). ` +
        "Download chapters individually or split the manuscript.",
    );
  }

  const out = new Uint8Array(44 + totalData);
  const view = new DataView(out.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + totalData, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, first.channels, true);
  view.setUint32(24, first.sampleRate, true);
  view.setUint32(28, first.sampleRate * first.channels * 2, true);
  view.setUint16(32, first.channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, totalData, true);

  let cursor = 44;
  for (let i = 0; i < buffers.length; i++) {
    const meta = metas[i];
    out.set(new Uint8Array(buffers[i], meta.dataOffset, meta.dataLength), cursor);
    cursor += meta.dataLength;
    onProgress?.(0.5 + ((i + 1) / buffers.length) * 0.5);
  }

  return new Blob([out.buffer], { type: "audio/wav" });
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
