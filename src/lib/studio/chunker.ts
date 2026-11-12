/**
 * Text sanitization + deterministic smart chunking engine.
 *
 * Splits manuscripts into 1,500-2,500 character chunks suitable for TTS:
 *   1. Paragraph boundaries (`\n\n`) are always preferred.
 *   2. Oversized paragraphs fall back to sentence boundaries (`. `, `! `, `? `).
 *   3. Only a single sentence longer than the max limit is ever hard-split,
 *      and even then at word boundaries.
 */

import { MIN_CHUNK_LENGTH, MAX_CHUNK_LENGTH } from "./constants";

/**
 * Normalize text for speech: strip control characters, normalize whitespace,
 * collapse excessive newlines into paragraph breaks.
 */
export function sanitizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    // Remove non-printable control characters and zero-width artifacts
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\t\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Split text into sentences at `.`, `!`, `?`, `…` terminators (manual scan,
 * no regex lookbehind for maximum browser compatibility). Closing quotes and
 * brackets directly after a terminator stay attached to the sentence.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const terminators = new Set([".", "!", "?", "\u2026"]);
  const closers = new Set(['"', "'", "\u2019", "\u201d", ")", "]", "\u00bb"]);

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (terminators.has(ch)) {
      let j = i + 1;
      // Absorb trailing closers and extra ellipsis dots
      while (j < text.length && (closers.has(text[j]) || (ch === "\u2026" && text[j] === "."))) j++;
      if (j >= text.length || /\s/.test(text[j])) {
        const sentence = text.slice(start, j).trim();
        if (sentence) out.push(sentence);
        while (j < text.length && /\s/.test(text[j])) j++;
        start = j;
        i = j;
        continue;
      }
    }
    i++;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Hard-split an oversized sentence at word boundaries (last resort only). */
function splitOversizedSentence(sentence: string, maxLen: number): string[] {
  const words = sentence.split(" ");
  const parts: string[] = [];
  let buf = "";
  for (const w of words) {
    if (w.length > maxLen) {
      // A single word longer than maxLen must itself be sliced.
      if (buf) {
        parts.push(buf);
        buf = "";
      }
      for (let k = 0; k < w.length; k += maxLen) parts.push(w.slice(k, k + maxLen));
      continue;
    }
    if (buf && buf.length + 1 + w.length > maxLen) {
      parts.push(buf);
      buf = w;
    } else {
      buf = buf ? `${buf} ${w}` : w;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

/**
 * Break a paragraph longer than maxLen into pieces that each fit within
 * maxLen, cutting at sentence boundaries (never mid-sentence unless the
 * sentence itself exceeds maxLen).
 */
function splitParagraphIntoPieces(paragraph: string, maxLen: number): string[] {
  if (paragraph.length <= maxLen) return [paragraph];
  const pieces: string[] = [];
  let buf = "";
  for (const sentence of splitSentences(paragraph)) {
    const units = sentence.length > maxLen ? splitOversizedSentence(sentence, maxLen) : [sentence];
    for (const unit of units) {
      if (buf && buf.length + 1 + unit.length > maxLen) {
        pieces.push(buf);
        buf = unit;
      } else {
        buf = buf ? `${buf} ${unit}` : unit;
      }
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
}

interface Unit {
  text: string;
  /** true when the unit continues the current paragraph (join with a space). */
  sameParagraph: boolean;
}

/**
 * Deterministic smart chunker. Returns an array of ready-to-speak strings,
 * each targeting the 1,500-2,500 character window.
 */
export function chunkText(text: string, minLen = MIN_CHUNK_LENGTH, maxLen = MAX_CHUNK_LENGTH): string[] {
  const clean = sanitizeText(text);
  if (!clean) return [];

  // Flatten paragraphs into ordered units (paragraph-sized when possible,
  // sentence-groups only for paragraphs that exceed maxLen).
  const paragraphs = clean
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const queue: Unit[] = [];
  for (const paragraph of paragraphs) {
    const pieces = splitParagraphIntoPieces(paragraph, maxLen);
    for (let i = 0; i < pieces.length; i++) {
      queue.push({ text: pieces[i], sameParagraph: i > 0 });
    }
  }
  if (queue.length === 0) return [];

  const chunks: string[] = [];
  let buf = "";
  let i = 0;

  while (i < queue.length) {
    const unit = queue[i];
    if (!unit.text) {
      i++;
      continue;
    }
    const sep = buf === "" ? "" : unit.sameParagraph ? " " : "\n\n";

    if (buf.length + sep.length + unit.text.length <= maxLen) {
      // Fits: keep packing paragraph units into the current chunk.
      buf += sep + unit.text;
      i++;
    } else if (buf.length >= minLen) {
      // Buffer is already inside the target window: close the chunk.
      chunks.push(buf);
      buf = "";
    } else {
      // Buffer below the minimum but the unit does not fit: top up the
      // buffer with leading sentences from the unit.
      const sentences = splitSentences(unit.text);
      if (sentences.length <= 1) {
        // Single sentence that cannot be split: flush the small buffer and
        // start a fresh chunk with the unit (spec: never cut mid-sentence).
        if (buf) chunks.push(buf);
        buf = "";
      } else {
        let consumed = 0;
        for (let s = 0; s < sentences.length; s++) {
          const candidate = sentences[s];
          const joiner = buf === "" ? "" : " ";
          if (buf.length + joiner.length + candidate.length <= maxLen) {
            buf += joiner + candidate;
            consumed = s + 1;
          } else {
            break;
          }
        }
        if (consumed === 0) {
          // Nothing fit (buffer too large already): flush and retry.
          chunks.push(buf);
          buf = "";
        } else {
          const rest = sentences.slice(consumed).join(" ");
          queue.splice(i, 1, { text: rest, sameParagraph: true });
          if (buf.length >= minLen) {
            chunks.push(buf);
            buf = "";
          }
        }
      }
    }
  }
  if (buf) chunks.push(buf);

  // Merge a tiny trailing chunk back into its predecessor when possible.
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (last.length < minLen * 0.5 && prev.length + 2 + last.length <= maxLen) {
      chunks.splice(chunks.length - 2, 2, `${prev}\n\n${last}`);
    }
  }

  return chunks;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function estimateReadingSeconds(words: number, wordsPerMinute = 150): number {
  return (words / wordsPerMinute) * 60;
}
