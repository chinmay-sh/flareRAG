/**
 * Uploads the raw docs to R2 using your `wrangler login` (no R2 API keys), staying under
 * Cloudflare's API rate limit (~1200 requests / 5 min) with retry on 429. Resumable.
 *
 *   npm run r2:upload -- [--corpus corpora/<name>.jsonc] [<docs-dir>] [--rate 3.5] [--no-skip-existing]
 *
 * The bucket comes from the corpus file ("r2_bucket") (or $R2_BUCKET).
 * Object keys are the same relative paths the ingest script stores as `source` in Pinecone.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadCorpusFromArgs } from "./lib/corpus";
import { listDocuments } from "../src/ingest/files";

const API = process.env.CF_API_BASE ?? "https://api.cloudflare.com/client/v4";

const args: string[] = process.argv.slice(2);
const CORPUS = loadCorpusFromArgs(args);
const STATE_PATH = CORPUS.r2StatePath; // one uploaded key per line
const rateIdx = args.indexOf("--rate");
const RATE = rateIdx >= 0 ? parseFloat(args[rateIdx + 1]) : 3.5; // requests per second
const docsDir = path.resolve(args.find((a, i) => !a.startsWith("--") && i !== rateIdx + 1) ?? CORPUS.docs_dir ?? "");
const SKIP_EXISTING = !args.includes("--no-skip-existing");
const CONCURRENCY = 4;

const bucket = process.env.R2_BUCKET || CORPUS.r2_bucket || "";

// ─── Auth (reuses wrangler's OAuth login; refreshed on 401/403) ────────────────
let token = "";
function refreshToken() {
  const out = execSync("npx wrangler auth token --json", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  token = JSON.parse(out.slice(out.indexOf("{"))).token;
  if (!token) throw new Error("Could not read a token from `wrangler auth token`. Run `npx wrangler login`.");
}

async function api(method: string, urlPath: string, body?: BodyInit, contentType?: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(API + urlPath, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(contentType ? { "Content-Type": contentType } : {}) },
        body,
      });
    } catch (err) {
      if (attempt >= 8) throw err;
      await backoff(`network error (${err instanceof Error ? err.message : err})`, Math.min(5000 * 2 ** attempt, 120_000));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 8) return res;
      const wait = Number(res.headers.get("retry-after")) * 1000 || Math.min(5000 * 2 ** attempt, 120_000);
      await backoff(`HTTP ${res.status}`, wait);
      continue;
    }
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      refreshToken();
      continue;
    }
    return res;
  }
}

// ─── Rate limiter: at most RATE request starts per second, shared by all workers ───
let nextSlot = 0;
async function rateLimit() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + 1000 / RATE;
  if (slot > now) await sleep(slot - now);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Progress bar (redraws in place on a terminal; periodic lines otherwise) ───
const TTY = Boolean(process.stdout.isTTY);
const progress = { total: 0, uploaded: 0, failed: 0, bytes: 0, start: 0, waitingUntil: 0, waitReason: "", lastLine: 0 };

function fmtTime(sec: number) {
  if (!isFinite(sec)) return "--:--";
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

function renderProgress(final = false) {
  const { total, uploaded, failed, bytes, start } = progress;
  const done = uploaded + failed;
  const elapsed = (Date.now() - start) / 1000;
  const rate = elapsed > 0 ? done / elapsed : 0;
  const pct = total ? done / total : 1;
  const width = 30;
  const filled = Math.round(pct * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const waitLeft = Math.ceil((progress.waitingUntil - Date.now()) / 1000);
  const status = waitLeft > 0 ? ` · ⏸ ${progress.waitReason}, retrying in ${waitLeft}s` : "";
  const line =
    `${bar} ${(pct * 100).toFixed(1).padStart(5)}% ${done}/${total}` +
    ` · ${(bytes / 1024 ** 2).toFixed(1)} MB · ${rate.toFixed(1)}/s` +
    ` · ${final ? `took ${fmtTime(elapsed)}` : `ETA ${fmtTime(rate ? (total - done) / rate : Infinity)}`}` +
    (failed ? ` · ✗ ${failed} failed` : "") +
    status;
  if (TTY) {
    process.stdout.write(`\r\x1b[2K${line}${final ? "\n" : ""}`);
  } else if (final || Date.now() - progress.lastLine > 10_000) {
    progress.lastLine = Date.now();
    console.log(line);
  }
}

/** Prints a message above the progress bar without garbling it. */
function logAbove(msg: string) {
  if (TTY && progress.start) process.stdout.write(`\r\x1b[2K`);
  console.log(msg);
  if (progress.start) renderProgress();
}

async function backoff(reason: string, ms: number) {
  progress.waitReason = reason;
  progress.waitingUntil = Math.max(progress.waitingUntil, Date.now() + ms);
  if (!progress.start) console.log(`  … ${reason}, waiting ${Math.round(ms / 1000)}s`);
  await sleep(ms);
}

function objectPath(accountId: string, key: string) {
  return `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function listExisting(accountId: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor = "";
  do {
    await rateLimit();
    const qs = new URLSearchParams({ per_page: "1000", ...(cursor ? { cursor } : {}) });
    const res = await api("GET", `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects?${qs}`);
    if (!res.ok) throw new Error(`list failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { result?: { key: string }[]; result_info?: { cursor?: string; is_truncated?: boolean } };
    for (const o of json.result ?? []) keys.add(o.key);
    cursor = json.result_info?.is_truncated ? json.result_info.cursor ?? "" : "";
  } while (cursor);
  return keys;
}

async function main() {
  if (!bucket) throw new Error(`No bucket: set "r2_bucket" in ${CORPUS.corpus}.jsonc (or R2_BUCKET).`);
  if (!fs.existsSync(docsDir)) throw new Error(`Directory not found: ${docsDir}`);

  refreshToken();
  const accounts = (await (await api("GET", "/accounts")).json()) as { result?: { id: string; name: string }[] };
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? accounts.result?.[0]?.id;
  if (!accountId) throw new Error("Could not determine the account id (set CLOUDFLARE_ACCOUNT_ID).");
  if ((accounts.result?.length ?? 0) > 1 && !process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error("Several accounts found; set CLOUDFLARE_ACCOUNT_ID.");
  }

  const docs = [...listDocuments(docsDir)];
  const done = new Set(fs.existsSync(STATE_PATH) ? fs.readFileSync(STATE_PATH, "utf-8").split("\n").filter(Boolean) : []);
  if (SKIP_EXISTING) {
    try {
      for (const k of await listExisting(accountId)) done.add(k);
    } catch (err) {
      console.log(`(could not list existing objects, relying on ${path.basename(STATE_PATH)}: ${err instanceof Error ? err.message : err})`);
    }
  }

  const todo = docs.filter(([key]) => !done.has(key));
  console.log(`Bucket "${bucket}": ${docs.length} docs, ${docs.length - todo.length} already uploaded, ${todo.length} to go`);
  console.log(`Rate ${RATE}/s → about ${Math.ceil(todo.length / RATE / 60)} min\n`);

  if (todo.length === 0) return console.log("Nothing to upload.");

  const log = fs.createWriteStream(STATE_PATH, { flags: "a" });
  Object.assign(progress, { total: todo.length, start: Date.now() });
  const ticker = setInterval(renderProgress, 250);
  let i = 0;

  const worker = async () => {
    while (i < todo.length) {
      const [key, file] = todo[i++];
      const data = fs.readFileSync(file);
      await rateLimit();
      const res = await api("PUT", objectPath(accountId, key), data, "text/plain; charset=utf-8");
      if (res.ok) {
        progress.uploaded++;
        progress.bytes += data.length;
        log.write(key + "\n");
      } else {
        progress.failed++;
        logAbove(`  ✗ ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
    }
  };

  // Ctrl+C: finish the line cleanly; everything uploaded so far is already recorded.
  process.once("SIGINT", () => {
    clearInterval(ticker);
    renderProgress(true);
    console.log(`Interrupted. ${progress.uploaded} uploaded this run; re-run the same command to continue.`);
    process.exit(130);
  });

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  clearInterval(ticker);
  renderProgress(true);
  log.end();

  console.log(`\nDone: ${progress.uploaded} uploaded, ${progress.failed} failed.${progress.failed ? " Re-run to retry the failures." : ""}`);
  if (progress.failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
