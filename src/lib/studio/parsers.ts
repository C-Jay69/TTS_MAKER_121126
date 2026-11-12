/**
 * Client-side manuscript parsing layer.
 *
 * Supported formats: .txt, .md, .docx (mammoth), .pdf (pdf.js), .doc (best-effort
 * binary extraction). Everything runs in the browser; no file bytes ever leave
 * the client except during explicit TTS calls the user triggers.
 */

import type { ParseResult } from "./constants";
import { SUPPORTED_EXTENSIONS } from "./constants";

export function getFileExtension(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  return idx === -1 ? "" : fileName.slice(idx).toLowerCase();
}

export function isSupportedFile(fileName: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(getFileExtension(fileName));
}

/** FileReader-based text read (readAsText), promisified. */
function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
    reader.readAsText(file);
  });
}

function readAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
    reader.readAsArrayBuffer(file);
  });
}

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

/**
 * Strip common Markdown syntax so the TTS engine does not read markup
 * characters aloud. Keeps the human-readable content of links/images.
 */
export function stripMarkdown(md: string): string {
  let t = md;

  // Fenced code blocks: drop the fence markers, keep the code content.
  t = t.replace(/```[a-zA-Z0-9_-]*\n?/g, "");
  // Inline code
  t = t.replace(/`{1,3}([^`]*)`{1,3}/g, "$1");
  // Images -> alt text, links -> link text
  t = t.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, "$1");
  t = t.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1");
  // Reference-style links: [text]: url  (drop url)
  t = t.replace(/^\s*\[([^\]]+)\]:\s*\S+.*$/gm, "");
  // Headings
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  // Headings with underline style
  t = t.replace(/^\s{0,3}=+\s*$/gm, "");
  t = t.replace(/^\s{0,3}-+\s*$/gm, "");
  // Blockquotes
  t = t.replace(/^\s{0,3}>\s?/gm, "");
  // Horizontal rules
  t = t.replace(/^\s{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, "");
  // List bullets / ordered markers
  t = t.replace(/^\s{0,3}[-+*]\s+/gm, "");
  t = t.replace(/^\s{0,3}\d+[.)]\s+/gm, "");
  // Bold / italic / strikethrough
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/__([^_]+)__/g, "$1");
  t = t.replace(/\*([^*\n]+)\*/g, "$1");
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, "$1$2");
  t = t.replace(/~~([^~]+)~~/g, "$1");
  // Tables: keep cell text, drop separator rows
  t = t.replace(/^\s*\|?[-:\s|]+\|[-:\s|]*\|\s*$/gm, "");
  t = t.replace(/\|/g, " ");
  // Raw HTML tags
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  // Escaped markdown chars
  t = t.replace(/\\([\\`*_{}[\]()#+\-.!~|])/g, "$1");

  return t;
}

/* ------------------------------------------------------------------ */
/* PDF (pdf.js)                                                        */
/* ------------------------------------------------------------------ */

/**
 * Merge pdf.js line items into paragraph-ish text:
 * lines that continue a sentence are unwrapped to single spaces,
 * remaining line breaks are treated as paragraph breaks.
 */
function joinPdfLines(lines: string[]): string {
  const joined = lines
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n");
  return joined
    // Unwrap lines that continue a sentence (next line starts lowercase/digit/open quote)
    .replace(/([^.!?:;])\n(?=[a-z0-9\u201c"'(\[])/g, "$1 ")
    // Remaining line breaks become paragraph breaks
    .replace(/\n+/g, "\n\n");
}

async function extractPdfText(file: File): Promise<ParseResult> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const data = new Uint8Array(await readAsArrayBuffer(file));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;

  const pageTexts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let line = "";
    const lines: string[] = [];
    for (const item of content.items) {
      if ("str" in item) {
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
    }
    if (line.trim().length > 0) lines.push(line);
    pageTexts.push(joinPdfLines(lines));
    page.cleanup();
  }

  const numPages = doc.numPages;
  await doc.destroy();

  const text = pageTexts.join("\n\n").trim();
  const warnings: string[] = [];
  if (text.length === 0 && numPages > 0) {
    warnings.push(
      `No selectable text found in the PDF (${numPages} page${numPages === 1 ? "" : "s"}). It is probably a scanned document requiring OCR.`,
    );
  }
  return { text, warnings };
}

/* ------------------------------------------------------------------ */
/* DOCX (mammoth)                                                      */
/* ------------------------------------------------------------------ */

async function extractDocxText(file: File): Promise<ParseResult> {
  const arrayBuffer = await readAsArrayBuffer(file);
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ arrayBuffer });
  const text = (result.value ?? "").trim();
  const warnings: string[] = [];
  if (result.messages?.some((m) => m.type === "warning")) {
    warnings.push("The .docx file contained some unsupported formatting; text was extracted best-effort.");
  }
  return { text, warnings };
}

/* ------------------------------------------------------------------ */
/* Legacy .doc (binary, best-effort)                                   */
/* ------------------------------------------------------------------ */

function isPrintableUtf16Code(code: number): boolean {
  if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
  if (code === 0x7f) return false;
  if (code >= 0x80 && code <= 0x9f) return false; // C1 control range
  return code <= 0xfffd;
}

function isPrintableByte(b: number): boolean {
  return (
    b === 0x09 ||
    b === 0x0a ||
    b === 0x0d ||
    (b >= 0x20 && b <= 0x7e) ||
    (b >= 0xa0 && b <= 0xff) // windows-1252 printable high range
  );
}

/** Extract runs of printable UTF-16LE code units (Word often stores text this way). */
function extractUtf16Runs(bytes: Uint8Array, minRun: number): string {
  const out: string[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= minRun) out.push(run.map((c) => String.fromCharCode(c)).join(""));
    run = [];
  };
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (isPrintableUtf16Code(code)) {
      run.push(code);
    } else {
      flush();
    }
  }
  flush();
  return out.join("\n");
}

/** Extract runs of printable single-byte text (windows-1252 / ASCII). */
function extractByteRuns(bytes: Uint8Array, minRun: number): string {
  const decoder = new TextDecoder("windows-1252");
  const out: string[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start !== -1 && end - start >= minRun) out.push(decoder.decode(bytes.slice(start, end)));
    start = -1;
  };
  for (let i = 0; i < bytes.length; i++) {
    if (isPrintableByte(bytes[i])) {
      if (start === -1) start = i;
    } else {
      flush(i);
    }
  }
  flush(bytes.length);
  return out.join("\n");
}

/**
 * Legacy .doc files are OLE2 binary containers. Without a full parser we run a
 * best-effort extraction: pull printable UTF-16LE and windows-1252 runs out of
 * the byte stream and keep whichever encoding recovered more text.
 */
async function extractLegacyDocText(file: File): Promise<ParseResult> {
  const bytes = new Uint8Array(await readAsArrayBuffer(file));
  const MIN_RUN = 12;

  const utf16 = extractUtf16Runs(bytes, MIN_RUN);
  const singleByte = extractByteRuns(bytes, MIN_RUN);

  // Score = count of real-word-ish characters (letters/digits/spaces).
  const score = (s: string) => (s.match(/[A-Za-z0-9\u00C0-\u024F\u4E00-\u9FFF]/g) ?? []).length;

  let text = score(utf16) >= score(singleByte) ? utf16 : singleByte;

  // Drop junk that typically appears from binary structure names.
  text = text
    .split("\n")
    .filter((line) => {
      const l = line.trim();
      if (l.length < 3) return false;
      const wordChars = (l.match(/[A-Za-z0-9\u00C0-\u024F\u4E00-\u9FFF]/g) ?? []).length;
      return wordChars / l.length > 0.5;
    })
    .join("\n\n")
    .trim();

  const warnings = [
    "Legacy .doc files are parsed with a best-effort binary extractor. If you notice formatting artifacts or missing text, convert the document to .docx (or paste the text into a .txt file) for a clean result.",
  ];
  return { text, warnings };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function parseManuscriptFile(file: File): Promise<ParseResult> {
  const ext = getFileExtension(file.name);
  switch (ext) {
    case ".txt":
      return { text: (await readAsText(file)).trim(), warnings: [] };
    case ".md":
    case ".markdown":
      return { text: stripMarkdown(await readAsText(file)).trim(), warnings: [] };
    case ".pdf":
      return extractPdfText(file);
    case ".docx":
      return extractDocxText(file);
    case ".doc":
      return extractLegacyDocText(file);
    default:
      throw new Error(
        `Unsupported file type "${ext || file.name}". Supported: ${SUPPORTED_EXTENSIONS.join(", ")}`,
      );
  }
}
