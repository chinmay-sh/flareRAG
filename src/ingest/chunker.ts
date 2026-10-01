import type { ChunkMetadata } from "../types";

export interface ChunkOptions {
  maxChunkSize?: number; // default 2000 chars (~500 tokens)
  chunkOverlap?: number; // default 200 chars
  /**
   * Merge consecutive heading sections shorter than this (default 0 = off), as long as the
   * merged text stays within maxChunkSize. Useful for texts with a heading every few lines
   * (e.g. verse + commentary), which would otherwise produce many tiny chunks.
   */
  minChunkSize?: number;
  title?: string;
}

export interface DocumentChunk {
  id: string;
  /** Text sent to the embedding model: title + heading path + chunk text. */
  embedText: string;
  metadata: ChunkMetadata;
}

/**
 * Splits a markdown/text document into heading-aware chunks with overlap.
 * `source` is the document's relative path; chunk IDs are derived from its hash,
 * so they are stable across runs and never collide for long paths.
 */
export async function chunkDocument(
  source: string,
  content: string,
  options: ChunkOptions = {}
): Promise<DocumentChunk[]> {
  const maxSize = options.maxChunkSize ?? 2000;
  const overlap = Math.min(options.chunkOverlap ?? 200, Math.floor(maxSize / 4));
  const title = options.title || source;

  const normalized = content.replace(/\r\n/g, "\n");
  const rawChunks: { text: string; section?: string }[] = [];

  const sections = mergeSmallSections(splitByHeaders(normalized), options.minChunkSize ?? 0, maxSize);
  for (const sec of sections) {
    const pieces = sec.text.length <= maxSize ? [sec.text] : splitTextRecursive(sec.text, maxSize, overlap);
    for (const piece of pieces) {
      const text = piece.trim();
      if (text) rawChunks.push({ text, section: sec.section });
    }
  }

  const prefix = (await sha256Hex(source)).slice(0, 32);
  const totalChunks = rawChunks.length;

  return rawChunks.map((item, i) => {
    const context = [title, item.section].filter(Boolean).join(" > ");
    return {
      id: `${prefix}:${i}`,
      embedText: context ? `${context}\n\n${item.text}` : item.text,
      metadata: {
        source,
        title,
        ...(item.section ? { section: item.section } : {}),
        chunkIndex: i,
        totalChunks,
        text: item.text,
      },
    };
  });
}

/** Extracts the first H1 as the document title, falling back to the file name. */
export function extractTitle(content: string, fallback: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Section {
  section?: string; // heading path, e.g. "Architecture > Edge Routing > Caching"
  text: string;
}

function splitByHeaders(content: string): Section[] {
  const sections: Section[] = [];
  const headingStack: { level: number; text: string }[] = [];
  let currentLines: string[] = [];
  let inFence = false;

  const flush = () => {
    if (currentLines.some((l) => l.trim())) {
      sections.push({
        section: headingStack.map((h) => h.text).join(" > ") || undefined,
        text: currentLines.join("\n"),
      });
    }
    currentLines = [];
  };

  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      flush();
      const level = m[1].length;
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
      headingStack.push({ level, text: m[2].trim() });
    }
    currentLines.push(line);
  }
  flush();
  return sections;
}

/**
 * Joins a small section with the following ones until it reaches `minSize`, without
 * exceeding `maxSize`. The merged section is labelled with the heading path the parts
 * share (e.g. "Chapter 3" for "Chapter 3 > verse 5" + "Chapter 3 > commentary").
 */
function mergeSmallSections(sections: Section[], minSize: number, maxSize: number): Section[] {
  if (minSize <= 0) return sections;
  type Merged = Section & { paths: string[] };
  const out: Merged[] = [];
  const fits = (a: Merged, b: Section) => a.text.length + 2 + b.text.length <= maxSize;
  const append = (a: Merged, b: Merged) => {
    a.text += `\n\n${b.text}`;
    a.paths.push(...b.paths);
  };

  let current: Merged | null = null;
  const flush = () => {
    if (!current) return;
    // A group that is still small (e.g. the last section) joins the previous chunk if there is room.
    const prev = out[out.length - 1];
    if (current.text.length < minSize && prev && fits(prev, current)) append(prev, current);
    else out.push(current);
    current = null;
  };

  for (const sec of sections) {
    const next: Merged = { ...sec, paths: [sec.section ?? ""] };
    if (current && current.text.length < minSize && fits(current, sec)) {
      append(current, next);
      continue;
    }
    flush();
    current = next;
  }
  flush();
  return out.map(finishMerged);
}

function finishMerged(s: Section & { paths: string[] }): Section {
  if (s.paths.length === 1) return { section: s.section, text: s.text };
  const split = s.paths.map((p) => (p ? p.split(" > ") : []));
  const common: string[] = [];
  for (let i = 0; split.every((parts) => i < parts.length && parts[i] === split[0][i]); i++) common.push(split[0][i]);
  return { section: common.join(" > ") || s.paths.find(Boolean) || undefined, text: s.text };
}

function splitTextRecursive(text: string, maxSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const para of text.split(/\n\s*\n/)) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= maxSize) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);

    const tail = current ? current.slice(-overlap) : "";
    const withOverlap = tail ? `${tail}\n\n${para}` : para;
    if (withOverlap.length <= maxSize) {
      current = withOverlap;
    } else {
      // Paragraph too long on its own: hard-split it; keep the last slice open for merging.
      const slices = splitLongParagraph(para, maxSize, overlap);
      chunks.push(...slices.slice(0, -1));
      current = slices[slices.length - 1] ?? "";
    }
  }

  if (current.trim()) chunks.push(current);
  return chunks;
}

function splitLongParagraph(para: string, maxSize: number, overlap: number): string[] {
  const slices: string[] = [];
  let start = 0;

  while (start < para.length) {
    const end = Math.min(start + maxSize, para.length);
    let slice = para.slice(start, end);
    if (end < para.length) {
      // Prefer breaking at a sentence end, then at whitespace.
      const sentence = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("\n"));
      const space = slice.lastIndexOf(" ");
      const cut = sentence > maxSize * 0.6 ? sentence + 1 : space > maxSize * 0.6 ? space : -1;
      if (cut > 0) slice = slice.slice(0, cut);
    }
    slices.push(slice);
    if (end >= para.length && slice.length === end - start) break;
    start += Math.max(slice.length - overlap, 1);
  }

  return slices;
}
