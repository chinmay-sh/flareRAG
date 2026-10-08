/**
 * Corpus configuration.
 *
 * Everything corpus-specific lives in one file, e.g. corpora/mycorpus.jsonc:
 *   { "worker": "mycorpus-search", "r2_bucket": "mycorpus-bucket", "docs_dir": "C:/path/to/docs", "vars": { … } }
 *
 * wrangler.jsonc holds only the shared Worker settings. `npm run deploy|dev|wrangler` merge the
 * two into wrangler.generated.jsonc, and the ingest/check/R2 scripts read the same file, so the
 * Worker and the scripts always agree. Pick the corpus with `--corpus <file or name>` or set
 * CORPUS=corpora/mycorpus.jsonc in .env to switch every command at once. API keys stay in .env.
 *
 * Secret values (like MCP_TOKEN) don't belong in the corpus file itself. Instead put a
 * "${MCP_TOKEN}" placeholder in vars and keep the real value in a gitignored .env next to the
 * corpus file (corpora/<name>.env) or in the root .env; it is expanded when the corpus is loaded,
 * before anything is deployed or merged into wrangler.generated.jsonc.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import "dotenv/config";
import { parse, type ParseError } from "jsonc-parser";
import { resolveEmbeddingSettings } from "../../src/services/embeddings";

export const WRANGLER_BASE_PATH = path.resolve("wrangler.jsonc");
export const WRANGLER_GENERATED_PATH = path.resolve("wrangler.generated.jsonc");
const CORPORA_DIR = path.resolve("corpora");
const SECRET_KEYS = ["VOYAGE_API_KEY", "GEMINI_API_KEY", "PINECONE_API_KEY"];
const REQUIRED_VARS = ["PINECONE_INDEX_HOST", "PINECONE_NAMESPACE"];

export interface CorpusFile {
  /** Cloudflare Worker name (its URL becomes https://<worker>.<subdomain>.workers.dev). */
  worker: string;
  /** Optional R2 bucket with the raw documents (enables get_full_document / list_documents). */
  r2_bucket?: string;
  /** Optional default docs folder for `npm run ingest` / `npm run r2:upload`. */
  docs_dir?: string;
  /** Opt in to contextual chunk embeddings (Voyage only); defaults to false. */
  context_embedding_enabled?: boolean;
  /** Worker vars, merged over the shared ones in wrangler.jsonc. Also read by the scripts. */
  vars: Record<string, string>;
}

export interface CorpusConfig extends CorpusFile {
  /** Short name = file name without extension, e.g. "mycorpus". */
  corpus: string;
  file: string;
  /** Shared vars from wrangler.jsonc merged with the corpus vars (corpus wins). */
  mergedVars: Record<string, string>;
  /** Per-corpus progress files so corpora never share ingest/upload state. */
  manifestPath: string;
  r2StatePath: string;
}

export function readJsonc<T>(file: string): T {
  const errors: ParseError[] = [];
  const data = parse(fs.readFileSync(file, "utf-8"), errors, { allowTrailingComma: true }) as T;
  if (errors.length) throw new Error(`${path.relative(".", file)} has ${errors.length} syntax error(s) (offset ${errors[0].offset}).`);
  return data;
}

export function listCorpusFiles(): string[] {
  if (!fs.existsSync(CORPORA_DIR)) return [];
  return fs
    .readdirSync(CORPORA_DIR)
    .filter((f) => /\.jsonc?$/.test(f))
    .map((f) => path.join("corpora", f).split(path.sep).join("/"));
}

/** Removes `--corpus <file|name>` from argv and returns it, falling back to $CORPUS (e.g. from .env). */
export function takeCorpusArg(args: string[]): string | undefined {
  const i = args.indexOf("--corpus");
  if (i >= 0) {
    const [, value] = args.splice(i, 2);
    return value;
  }
  return process.env.CORPUS;
}

function resolveCorpusFile(ref: string): string {
  const candidates = [ref, path.join(CORPORA_DIR, `${ref}.jsonc`), path.join(CORPORA_DIR, `${ref}.json`)];
  const found = candidates.map((c) => path.resolve(c)).find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
  if (!found) {
    throw new Error(`Corpus file not found: "${ref}". Available: ${listCorpusFiles().join(", ") || "(none in corpora/)"}`);
  }
  return found;
}

/** Loads a corpus file (path or short name) and validates it. Does not touch process.env. */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Expands ${NAME} placeholders in a value using a lookup that falls back to process.env. */
function expandPlaceholders(value: string, extra: Record<string, string>, file: string, key: string): string {
  const missing = new Set<string>();
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const hit = extra[name] ?? process.env[name];
    if (hit === undefined || hit === "") {
      missing.add(name);
      return "";
    }
    return hit;
  });
  if (missing.size) {
    throw new Error(
      `${path.relative(".", file)}: vars.${key} uses ${[...missing].map((m) => "${" + m + "}").join(", ")}, which is not set. ` +
        `Set it in corpora/<name>.env (next to the corpus file, gitignored), the root .env, or the environment.`
    );
  }
  return expanded;
}

export function readCorpus(ref: string | undefined): CorpusConfig {
  if (!ref) {
    throw new Error(
      `No corpus selected. Pass --corpus <file> or set CORPUS=<file> in .env. Available: ${listCorpusFiles().join(", ") || "(none)"}`
    );
  }
  const file = resolveCorpusFile(ref);
  const corpus = path.basename(file).replace(/\.jsonc?$/, "");
  const data = readJsonc<CorpusFile>(file);
  if (!data.worker) throw new Error(`${path.relative(".", file)}: "worker" (the Worker name) is required.`);
  if (data.context_embedding_enabled !== undefined && typeof data.context_embedding_enabled !== "boolean") {
    throw new Error(`${path.relative(".", file)}: context_embedding_enabled must be a boolean (true or false).`);
  }

  // Secrets ride along in a gitignored .env next to the corpus file (corpora/<name>.env).
  const secretsPath = file.replace(/\.jsonc?$/, ".env");
  const corpusSecrets = fs.existsSync(secretsPath) ? parseEnvFile(fs.readFileSync(secretsPath, "utf-8")) : {};

  const base = readJsonc<{ vars?: Record<string, string> }>(WRANGLER_BASE_PATH);
  const expandedVars = Object.fromEntries(
    Object.entries(data.vars ?? {}).map(([k, v]) => [k, expandPlaceholders(v, corpusSecrets, file, k)])
  );
  const contextEmbeddingEnabled = data.context_embedding_enabled ?? false;
  const mergedVars: Record<string, string> = {
    ...(base.vars ?? {}), ...expandedVars,
    CONTEXT_EMBEDDING_ENABLED: String(contextEmbeddingEnabled),
  };
  resolveEmbeddingSettings(mergedVars);
  for (const key of REQUIRED_VARS) {
    if (!mergedVars[key]) throw new Error(`${path.relative(".", file)}: vars.${key} is required.`);
  }
  for (const key of SECRET_KEYS) {
    if (key in mergedVars) throw new Error(`${path.relative(".", file)}: ${key} is a secret; keep it in .env / wrangler secrets, not in vars.`);
  }

  return {
    ...data,
    context_embedding_enabled: contextEmbeddingEnabled,
    vars: data.vars ?? {},
    corpus,
    file,
    mergedVars,
    manifestPath: path.resolve(`.ingest-manifest.${corpus}.json`),
    r2StatePath: path.resolve(`.r2-uploaded.${corpus}.txt`),
  };
}

/**
 * Loads a corpus for the local scripts and copies its vars into process.env, so the shared
 * services (createEmbedder, Pinecone settings) see exactly what the Worker sees. Corpus values
 * win over .env; a differing .env value is reported because ingest and search would disagree.
 */
export function loadCorpus(ref: string | undefined): CorpusConfig {
  const cfg = readCorpus(ref);
  for (const [key, value] of Object.entries(cfg.mergedVars)) {
    const fromDotEnv = process.env[key];
    if (fromDotEnv !== undefined && fromDotEnv !== value && key !== "MCP_TOKEN") {
      console.warn(`⚠  .env sets ${key}="${fromDotEnv}", but corpus "${cfg.corpus}" uses "${value}" (using the corpus value).`);
    }
    process.env[key] = value;
  }
  return cfg;
}

/** Shorthand for scripts: parse --corpus from argv (mutating it) and load it, exiting with a message on error. */
export function loadCorpusFromArgs(args: string[]): CorpusConfig {
  try {
    return loadCorpus(takeCorpusArg(args));
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
    throw err;
  }
}
