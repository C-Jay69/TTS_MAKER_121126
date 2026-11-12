/**
 * Parser verification: run the browser parsers under bun against fixtures.
 * pdf.js is imported from the legacy build (Node-compatible) to emulate the
 * browser module's text extraction path. mammoth runs natively.
 *
 * Run: bun run scripts/test-parsers.ts
 */

import { readFileSync } from "node:fs";
import { stripMarkdown, getFileExtension, isSupportedFile } from "../src/lib/studio/parsers";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}`, detail !== undefined ? String(detail).slice(0, 300) : "");
  }
}

const FIX = "/home/z/my-project/scripts/fixtures";

/* helper: File-like shim over Buffer */
function makeFile(name: string): File {
  const buf = readFileSync(`${FIX}/${name}`);
  const file = new File([buf], name);
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  });
  return file;
}

/* ------------------------------- .txt / .md ------------------------------- */

{
  const file = makeFile("sample.txt");
  // readAsText via File.text() is equivalent to FileReader in bun
  const text = await file.text();
  check("txt: has content", text.includes("Whispering Valley"));
  check("ext detection", getFileExtension("a.b.TXT") === ".txt" && isSupportedFile("x.docx") && !isSupportedFile("x.exe"));
}

{
  const md = makeFile("sample.md");
  const stripped = stripMarkdown(await md.text());
  check("md: heading markers removed", !stripped.includes("# The") && !stripped.includes("## "));
  check("md: bold/italic removed", !stripped.includes("**") && !stripped.includes("*thirteen*"));
  check("md: link -> text", stripped.includes("old bakery") && !stripped.includes("](https"));
  check("md: list markers removed", !stripped.includes("\n- He carried"));
  check("md: code fence markers removed but content noted", !stripped.includes("```"));
  check("md: table pipes removed", !stripped.includes("| Item |"));
  check("md: keeps prose", stripped.includes("bright cold day") && stripped.includes("remembers every voice"));
}

/* ---------------------------------- PDF ----------------------------------- */

{
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { pathToFileURL } = await import("node:url");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    "/home/z/my-project/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  ).href;
  const buf = readFileSync(`${FIX}/sample.pdf`);
  const data = new Uint8Array(buf);
  const loadingTask = pdfjs.getDocument({ data, isEvalSupported: false });
  const doc = await loadingTask.promise;
  let text = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
  }
  await loadingTask.destroy();
  check("pdf: 2 pages parsed", text.includes("Page one begins") && text.includes("Page two carries"), text.slice(0, 200));
  check("pdf: text extraction non-empty", text.trim().length > 50);
}

/* ---------------------------------- DOCX ---------------------------------- */

{
  // Use the browser bundle exactly like the Next.js client build does
  // (package.json "browser" field maps unzip.js -> browser/unzip.js which
  // accepts {arrayBuffer}).
  const mammoth = await import("mammoth/mammoth.browser.js");
  const buf = readFileSync(`${FIX}/sample.docx`);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const result = await mammoth.extractRawText({ arrayBuffer });
  const text = result.value;
  check("docx: heading extracted", text.includes("The Whispering Valley"));
  check("docx: paragraphs extracted", text.includes("leather satchel") && text.includes("remembers every voice"));
  check("docx: no xml artifacts", !text.includes("<?xml") && !text.includes("<w:"));
}

/* ----------------------------------- DOC ---------------------------------- */

{
  // Import the doc extractor logic directly (module-level import pulls pdfjs
  // into the graph, so we re-implement the call through the module function).
  const mod = await import("../src/lib/studio/parsers.ts");
  const file = makeFile("sample.doc");
  const result = await mod.parseManuscriptFile(file);
  check("doc: extracts utf-16 text", result.text.includes("Legacy document text survives"), result.text.slice(0, 120));
  check("doc: attaches warning", result.warnings.length > 0 && result.warnings[0].includes("best-effort"));
}

process.exit(failures > 0 ? 1 : 0);
