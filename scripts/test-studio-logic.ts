/**
 * Unit tests for the Audiobook Studio core logic (chunker + WAV pipeline).
 * Run with: bun run scripts/test-studio-logic.ts
 */

import { chunkText, sanitizeText, splitSentences, countWords } from "../src/lib/studio/chunker";
import {
  analyzeWavs,
  buildAudiobookBlob,
  pcmToWav,
  parseWavHeader,
  stitchWavs,
  base64ToUint8Array,
} from "../src/lib/studio/wav";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : "");
  }
}

/* ------------------------------- sanitize --------------------------------- */

{
  const raw = "Hello\u0000\u0007 world\u00A0!\r\n\r\n\r\nSecond\tparagraph   text\u200B.";
  const clean = sanitizeText(raw);
  check("sanitize removes control chars", !clean.includes("\u0000") && !clean.includes("\u0007"));
  check("sanitize collapses newlines", !clean.includes("\n\n\n"));
  check("sanitize normalizes nbsp/tabs", !clean.includes("\u00A0") && !clean.includes("\t"));
  check("sanitize trims", clean === clean.trim());
}

/* ------------------------------- sentences -------------------------------- */

{
  const s = splitSentences('He said, "Stop." Then he left. Really!');
  check("adjacent closers stay attached", s[0] === 'He said, "Stop."' && s[1] === "Then he left." && s[2] === "Really!", s);
}

{
  const s = splitSentences("First sentence. Second one! Third? A quote ends. \"like this\" Final…");
  check("splits at . ! ?", s.length === 5, s);
  // A closer is only attached when DIRECTLY adjacent to the terminator
  // ("ends. \"like" -> the quote opens the next sentence).
  check("quote stays attached only when adjacent", s[3] === "A quote ends.", s[3]);
  check("quoted clause + ellipsis in one sentence", s[4] === '"like this" Final…', s[4]);
}

/* -------------------------------- chunker --------------------------------- */

{
  // Build a manuscript: 40 paragraphs of ~300 chars => ~12,000 chars
  const para =
    "The old lighthouse keeper climbed the spiral stairs each evening with a small oil lamp in his hand, " +
    "careful not to spill a single drop of the precious fuel that kept the great beacon alive through the night. ";
  const manuscript = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. ${para.repeat(2)}`).join("\n\n");

  const chunks = chunkText(manuscript);
  const sizes = chunks.map((c) => c.length);
  const min = Math.min(...sizes);
  const max = Math.max(...sizes);

  check("chunks within max limit", max <= 2500, { max });
  check("most chunks reach the 1500 target", sizes.filter((s) => s >= 1400).length >= sizes.length - 1, sizes);
  check("no chunk is empty", chunks.every((c) => c.trim().length > 0));
  check("reconstructs full text", chunks.join("\n\n").length >= manuscript.replace(/\n{2,}/g, "\n\n").length - 60, {
    original: manuscript.length,
    joined: chunks.join("\n\n").length,
  });
  check("sane chunk count (~12000 chars)", chunks.length >= 4 && chunks.length <= 10, { count: chunks.length, min, max });

  // Verify paragraph boundaries respected: every chunk should end with sentence-final punctuation
  check("chunks end at sentence boundaries", chunks.every((c) => /[.!?]$/.test(c.trim())));
}

{
  // Oversized single paragraph -> sentence fallback
  const longPara =
    "One very long paragraph. ".repeat(200) + // ~5000 chars, single paragraph
    "It ends here.";
  const chunks = chunkText(longPara);
  check("long paragraph split into multiple chunks", chunks.length >= 2, chunks.length);
  check("long paragraph chunks within limits", chunks.every((c) => c.length <= 2500), chunks.map((c) => c.length));
  check("sentence fallback keeps sentences intact", chunks.every((c) => /[.!?]$/.test(c.trim())));
}

{
  // A single sentence longer than the max limit -> hard split at word boundaries
  const monster = "word ".repeat(1200) + "end."; // ~6000 chars, one sentence
  const chunks = chunkText(monster);
  check("oversized sentence hard-split", chunks.length >= 2 && chunks.every((c) => c.length <= 2500), chunks.map((c) => c.length));
  check("no words lost in hard split", chunks.join(" ").split(/\s+/).filter(Boolean).length === 1201);
}

{
  // Markdown-heavy text should not influence chunk boundaries
  const md = Array.from({ length: 30 }, (_, i) => `## Heading ${i}\n\nSome **bold** text with [a link](https://example.com) and \`code\`.\n\n- item one\n- item two`).join("\n\n");
  const chunks = chunkText(md);
  check("markdown text chunks cleanly", chunks.length >= 1 && chunks.every((c) => c.length <= 2500));
}

{
  // Tiny text -> single chunk
  check("tiny text becomes one chunk", chunkText("Hello world.").length === 1);
  check("empty text becomes no chunks", chunkText("   \n\n  ").length === 0);
}

{
  // Determinism
  const text = "Paragraph one.\n\nParagraph two with more words to fill the buffer a bit.\n\nParagraph three.";
  check("chunking is deterministic", JSON.stringify(chunkText(text)) === JSON.stringify(chunkText(text)));
}

{
  check("countWords", countWords("one two  three\nfour") === 4);
}

/* --------------------------------- WAV ------------------------------------ */

{
  const sampleRate = 24000;
  const pcm1 = new Uint8Array(4800); // 0.1 s
  for (let i = 0; i < pcm1.length; i += 2) {
    pcm1[i] = i % 256;
    pcm1[i + 1] = 0;
  }
  const pcm2 = new Uint8Array(9600); // 0.2 s
  pcm2.fill(0xab);

  const wav1 = pcmToWav(pcm1, sampleRate);
  const wav2 = pcmToWav(pcm2, sampleRate);

  const meta1 = parseWavHeader(wav1);
  check("wav header: rate", meta1.sampleRate === sampleRate);
  check("wav header: channels/bits", meta1.channels === 1 && meta1.bitsPerSample === 16);
  check("wav header: data offset/length", meta1.dataOffset === 44 && meta1.dataLength === pcm1.length);

  const stitched = await stitchWavs([new Blob([wav1]), new Blob([wav2])]);
  const metaStitched = parseWavHeader(await stitched.arrayBuffer());
  check("stitched length = sum of PCM", metaStitched.dataLength === pcm1.length + pcm2.length);
  check("stitched is valid wav", metaStitched.sampleRate === sampleRate && metaStitched.bitsPerSample === 16);

  const bytes = new Uint8Array(await stitched.arrayBuffer());
  check("stitched payload preserves bytes", bytes[44] === pcm1[0] && bytes[44 + pcm1.length] === 0xab);

  // Duration math check: 14400 bytes = 7200 samples / 24000 Hz = 0.3 s
  check("stitched duration math", Math.abs(metaStitched.dataLength / 2 / sampleRate - 0.3) < 1e-9);

  // Mismatched formats should throw
  const wavOther = pcmToWav(pcm2, 48000);
  try {
    await stitchWavs([new Blob([wav1]), new Blob([wavOther])]);
    check("stitch rejects mixed sample rates", false);
  } catch (e) {
    check("stitch rejects mixed sample rates", e instanceof Error && e.message.includes("Mixed audio formats"));
  }
}

{
  // base64 decode
  const original = new Uint8Array([0, 1, 2, 250, 255, 128, 77]);
  const b64 = Buffer.from(original).toString("base64");
  const decoded = base64ToUint8Array(b64);
  check("base64 roundtrip", decoded.every((b, i) => b === original[i]));
}

/* ------------------------- full-book composition -------------------------- */

{
  const sampleRate = 24000;
  const piece = new Uint8Array(2400); // 0.05 s
  piece.fill(0x11);
  const blobs = Array.from({ length: 5 }, () => new Blob([pcmToWav(piece, sampleRate)]));

  const set = await analyzeWavs(blobs);
  check("analyze totals PCM", set.totalData === piece.length * 5 && set.sampleRate === sampleRate, set);

  // The export composes header + slices instead of copying the PCM.
  const composed = await buildAudiobookBlob(blobs);
  const composedMeta = parseWavHeader(await composed.slice(0, 44).arrayBuffer(), {
    trustDeclaredDataLength: true,
  });
  check("composition declares every sample", composedMeta.dataLength === piece.length * 5, composedMeta);
  check("composition reports its real size", composed.size === 44 + piece.length * 5, composed.size);

  const composedBytes = new Uint8Array(await composed.arrayBuffer());
  check(
    "composition keeps the payload in order",
    composedBytes[44] === 0x11 && composedBytes[44 + piece.length * 4] === 0x11,
  );

  // Progress reaches 100% once the whole book is composed.
  let lastRatio = 0;
  await buildAudiobookBlob(blobs, (ratio) => {
    lastRatio = ratio;
  });
  check("composition reports completion", lastRatio === 1, lastRatio);
}

process.exit(failures > 0 ? 1 : 0);
