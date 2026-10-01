/**
 * Near-duplicate detection for retrieved chunks. The same memo often exists in several
 * files (re-scans, copies), with slightly different OCR and chunk boundaries, so exact
 * matching isn't enough. Two texts are duplicates when most of the word 3-grams of the
 * shorter one also occur in the other (containment), which tolerates shifted boundaries.
 */

const SHINGLE = 3;
const MIN_SHINGLES = 5; // below this, only identical normalized text counts as a duplicate

export interface DedupeGroup<T> {
  item: T; // first (best-ranked) member
  duplicates: T[];
}

function words(text: string): string[] {
  // \p{M} keeps combining marks (e.g. Devanagari vowel signs, IAST m̐) inside the word.
  return text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

function shingles(ws: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= ws.length; i++) out.add(ws.slice(i, i + SHINGLE).join(" "));
  return out;
}

function containment(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let shared = 0;
  for (const s of small) if (large.has(s)) shared++;
  return shared / small.size;
}

/**
 * Groups near-duplicate items, preserving input order (pass them best-first).
 * O(n²) over the candidate list, which is fine for the ≤100 candidates of a search.
 */
export function dedupe<T>(items: T[], getText: (item: T) => string, threshold = 0.7): DedupeGroup<T>[] {
  const groups: (DedupeGroup<T> & { norm: string; sh: Set<string> })[] = [];

  for (const item of items) {
    const ws = words(getText(item));
    const norm = ws.join(" ");
    const sh = shingles(ws);

    const match = groups.find((g) =>
      g.norm === norm ||
      (sh.size >= MIN_SHINGLES && g.sh.size >= MIN_SHINGLES && containment(sh, g.sh) >= threshold)
    );
    if (match) match.duplicates.push(item);
    else groups.push({ item, duplicates: [], norm, sh });
  }

  return groups.map(({ item, duplicates }) => ({ item, duplicates }));
}
