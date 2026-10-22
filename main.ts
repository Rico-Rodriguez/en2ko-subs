/**
 * main.ts — "EN→KO Subs (AI Translate)" Stremio subtitles addon, Deno port.
 *
 * Single-file Deno Deploy app; a faithful port of the Node version
 * (../server.js + ../src/translate.js, which remain the reference
 * implementation). Serves Korean subtitles for English-language content by
 * translating the best English track from the public OpenSubtitles v3 addon
 * on demand with the free keyless Google Translate (gtx) endpoint, caching
 * results in Deno KV (in-memory fallback when KV is unavailable).
 *
 * Endpoints (Stremio addon protocol — identical in shape to the Node one):
 *   GET /manifest.json
 *   GET /subtitles/:type/:id[/:extra].json
 *   GET /s/:hash.srt            — the translated file itself
 *
 * Run locally:  deno run --allow-net --allow-env --unstable-kv main.ts
 * Env: PORT (local listen port; unset on Deploy — platform-managed),
 *      BASE_URL (override the public base used in subtitle URLs;
 *      default: the request's own origin),
 *      EN2KO_NO_KV=1 (force the in-memory cache; useful for tests).
 */

// ---------------------------------------------------------------------------
// Manifest (identical to the Node version)
// ---------------------------------------------------------------------------

const MANIFEST = {
  id: "community.en2ko.subs",
  version: "1.0.0",
  name: "EN→KO Subs (AI Translate)",
  description:
    "Korean subtitles for English-language content, translated on demand from the best English track on OpenSubtitles (free Google Translate backend). First request for a title is slow; results are cached.",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
};

const OS_V3 = "https://opensubtitles-v3.strem.io";

// ---------------------------------------------------------------------------
// Translation core — ported from src/translate.js
// (fetch-only: no child_process/curl fallback exists on Deploy)
// ---------------------------------------------------------------------------

export const GT_ENDPOINT =
  "https://translate.googleapis.com/translate_a/single";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** sha256 hex of a string (used as the translation-cache key). */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Download a URL as text via global fetch (Deno's fetch honors the
 * HTTP(S)_PROXY env vars). Returns { status, text }; network-level
 * failures throw (the Node version's curl fallback has no Deploy analog).
 */
export async function downloadText(
  url: string,
  { timeoutMs = 30000 }: { timeoutMs?: number } = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, text: await res.text() };
}

export interface SrtBlock {
  index: string;
  time: string;
  lines: string[];
}

/**
 * Parse SRT text into blocks: { index, time, lines[] }.
 * Non-block preamble (e.g. a WEBVTT header) is dropped.
 */
export function parseSrt(text: string): SrtBlock[] {
  const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(
    /^\uFEFF/,
    "",
  );
  const blocks: SrtBlock[] = [];
  for (const raw of norm.split(/\n{2,}/)) {
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < 2) continue;
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx === -1) continue;
    blocks.push({
      index: lines[0].trim(),
      time: lines[timeIdx].trim(),
      lines: lines.slice(timeIdx + 1),
    });
  }
  return blocks;
}

/** Serialize blocks back to SRT text (CRLF, canonical SubRip). */
export function serializeSrt(blocks: SrtBlock[]): string {
  return (
    blocks
      .map((b) => [b.index, b.time, ...b.lines].join("\r\n"))
      .join("\r\n\r\n") + "\r\n"
  );
}

export interface TranslateOpts {
  sl?: string;
  tl?: string;
  chunkChars?: number;
  interChunkDelayMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  onProgress?: (done: number, total: number) => void;
  /**
   * Injectable translation backend (joined chunk text -> translated text).
   * Defaults to the gtx endpoint with retries. Exists so the chunk /
   * reassembly pipeline can be exercised offline with a stub.
   */
  translateFn?: (
    text: string,
    opts: { sl: string; tl: string },
  ) => Promise<string>;
}

interface GtxError extends Error {
  status?: number;
}

/**
 * One Google Translate (gtx) request. Returns the translated string or
 * throws on rate-limit / unexpected responses; callers retry.
 * q may contain newlines: they are preserved by the endpoint and used as
 * item separators by translateItems().
 */
async function gtxTranslate(
  text: string,
  { sl = "en", tl = "ko" }: { sl?: string; tl?: string } = {},
): Promise<string> {
  const params = new URLSearchParams({
    client: "gtx",
    sl,
    tl,
    dt: "t",
    ie: "UTF-8",
    oe: "UTF-8",
    q: text,
  });
  const { status, text: body } = await downloadText(`${GT_ENDPOINT}?${params}`, {
    timeoutMs: 30000,
  });
  if (status !== 200) {
    const err: GtxError = new Error(`gtx HTTP ${status}`);
    err.status = status;
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    // The "sorry" interstitial is HTML, not JSON — treat as rate limit.
    const err: GtxError = new Error(
      "gtx returned non-JSON (rate-limit interstitial)",
    );
    err.status = 429;
    throw err;
  }
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error("gtx unexpected response shape");
  }
  return (data[0] as unknown[])
    .map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
    .join("");
}

async function gtxWithRetries(
  text: string,
  opts: { sl?: string; tl?: string },
  { maxRetries = 5, baseDelayMs = 4000 }: {
    maxRetries?: number;
    baseDelayMs?: number;
  } = {},
): Promise<string> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await gtxTranslate(text, opts);
    } catch (err) {
      lastErr = err as Error;
      if (attempt < maxRetries) {
        const wait = Math.min(baseDelayMs * 2 ** attempt, 60000);
        console.warn(
          `[en2ko] gtx attempt ${attempt + 1} failed (${lastErr.message}); retrying in ${
            (wait / 1000).toFixed(0)
          }s`,
        );
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

/**
 * Translate an array of independent text items (subtitle lines), preserving
 * item count and order. Items are batched into newline-joined chunks under
 * the endpoint's query-length limit; if a chunk's line count comes back
 * wrong, its items are retried one by one.
 */
export async function translateItems(
  items: string[],
  opts: TranslateOpts = {},
): Promise<string[]> {
  const {
    chunkChars = 4000,
    interChunkDelayMs = 700,
    maxRetries,
    baseDelayMs,
    onProgress,
  } = opts;
  const backend = opts.translateFn ??
    ((t: string, o: { sl: string; tl: string }) =>
      gtxWithRetries(t, o, { maxRetries, baseDelayMs }));
  const langOpts = { sl: opts.sl ?? "en", tl: opts.tl ?? "ko" };

  const results = new Array<string>(items.length);
  // Items with no letters/digits (e.g. "♪", "...", "--") pass through.
  const todo: number[] = [];
  items.forEach((it, i) => {
    if (/[\p{L}\p{N}]/u.test(it)) todo.push(i);
    else results[i] = it;
  });

  // Build chunks of item indices whose joined text fits the char budget.
  const chunks: number[][] = [];
  let cur: number[] = [];
  let curLen = 0;
  for (const i of todo) {
    const add = items[i].length + 1;
    if (cur.length && curLen + add > chunkChars) {
      chunks.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(i);
    curLen += add;
  }
  if (cur.length) chunks.push(cur);

  let done = 0;
  for (const chunk of chunks) {
    const joined = chunk.map((i) => items[i]).join("\n");
    // Hard failures (rate limit / network) propagate: retrying item-by-item
    // against the same wall would just multiply the wait. Per-item fallback
    // below is only for a successful response with a wrong line count.
    const translated = await backend(joined, langOpts);
    const parts = translated.split("\n");
    if (parts.length === chunk.length) {
      chunk.forEach((idx, k) => (results[idx] = parts[k].trim()));
    } else {
      // Fallback: one request per item in this chunk.
      for (const idx of chunk) {
        results[idx] = await backend(items[idx], langOpts);
      }
    }
    done += chunk.length;
    if (onProgress) onProgress(done, todo.length);
    if (interChunkDelayMs) await sleep(interChunkDelayMs);
  }
  return results;
}

/**
 * Translate a whole SRT document EN→KO. Indices and timestamps are never
 * sent to the translator; only cue text lines are, and the document is
 * reassembled with its original structure.
 */
export async function translateSrt(
  enSrtText: string,
  opts: TranslateOpts = {},
): Promise<string> {
  const blocks = parseSrt(enSrtText);
  const flat: string[] = [];
  const positions: [number, number][] = [];
  blocks.forEach((b, bi) => {
    b.lines.forEach((line, li) => {
      positions.push([bi, li]);
      flat.push(line);
    });
  });
  const translated = await translateItems(flat, opts);
  positions.forEach(([bi, li], k) => {
    blocks[bi].lines[li] = translated[k];
  });
  return serializeSrt(blocks);
}

// ---------------------------------------------------------------------------
// Cache — Deno KV when available, in-memory Map otherwise.
// KV values are capped at 64 KiB, so long texts (translated SRTs) are
// stored as a chunk count + per-chunk string values, split on UTF-8 byte
// boundaries. The Map fallback uses the identical key scheme.
// ---------------------------------------------------------------------------

interface KvLike {
  get(key: unknown[]): Promise<{ value: unknown }>;
  set(key: unknown[], value: unknown): Promise<unknown>;
}

const memStore = new Map<string, unknown>();
let kvPromise: Promise<KvLike | null> | null = null;

function getKv(): Promise<KvLike | null> {
  if (!kvPromise) {
    kvPromise = (async () => {
      if (Deno.env.get("EN2KO_NO_KV") === "1") return null;
      try {
        // Accessed indirectly: openKv is an unstable API and its typings
        // vary across Deno versions; a missing/throwing openKv must fall
        // back to memory, never crash the addon.
        const openKv =
          (Deno as unknown as { openKv?: () => Promise<KvLike> }).openKv;
        if (!openKv) return null;
        const kv = await openKv();
        console.log("[en2ko] cache: Deno KV");
        return kv;
      } catch (err) {
        console.warn(
          `[en2ko] Deno KV unavailable (${(err as Error).message}); using in-memory cache`,
        );
        return null;
      }
    })();
  }
  return kvPromise;
}

async function rawGet(parts: string[]): Promise<unknown> {
  const kv = await getKv();
  if (kv) return (await kv.get(parts)).value;
  return memStore.get(JSON.stringify(parts)) ?? null;
}

async function rawSet(parts: string[], value: unknown): Promise<void> {
  const kv = await getKv();
  if (kv) {
    await kv.set(parts, value);
  } else {
    memStore.set(JSON.stringify(parts), value);
  }
}

const CHUNK_BYTES = 60000; // safely under Deno KV's 64 KiB value limit

function splitByBytes(text: string, maxBytes: number): string[] {
  const enc = new TextEncoder();
  const chunks: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of text) {
    const b = enc.encode(ch).length;
    if (cur && curBytes + b > maxBytes) {
      chunks.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur || !chunks.length) chunks.push(cur);
  return chunks;
}

/** Store a (possibly long) text under [prefix, hash] as count + chunks. */
export async function setCachedText(
  prefix: string,
  hash: string,
  text: string,
): Promise<void> {
  const chunks = splitByBytes(text, CHUNK_BYTES);
  await rawSet([prefix, hash, "n"], chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    await rawSet([prefix, hash, "c", String(i)], chunks[i]);
  }
}

/** Read back a text stored by setCachedText; null when absent. */
export async function getCachedText(
  prefix: string,
  hash: string,
): Promise<string | null> {
  const n = await rawGet([prefix, hash, "n"]);
  if (typeof n !== "number") return null;
  let out = "";
  for (let i = 0; i < n; i++) {
    const part = await rawGet([prefix, hash, "c", String(i)]);
    if (typeof part !== "string") return null;
    out += part;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Addon logic (mirrors server.js)
// ---------------------------------------------------------------------------

interface OsEntry {
  lang?: string;
  g?: string | number;
  url?: string;
}

/**
 * English entries from the OpenSubtitles v3 response, in preference order:
 * 'g' tier (a quality/downloads tier in the v3 payload) descending, then
 * original list order (Array.sort is stable, so equal tiers keep it).
 * Entries without a download URL are unusable and dropped.
 */
export function rankEnglish(osJson: { subtitles?: OsEntry[] }): OsEntry[] {
  const subs = (osJson.subtitles || []).filter(
    (s) => (s.lang === "eng" || s.lang === "en") && s.url,
  );
  subs.sort((a, b) => Number(b.g || 0) - Number(a.g || 0));
  return subs;
}

/** The single most-preferred English entry (first of rankEnglish). */
export function pickEnglish(osJson: { subtitles?: OsEntry[] }): OsEntry | null {
  return rankEnglish(osJson)[0] ?? null;
}

/** Parse an SRT timestamp ("hh:mm:ss,mmm") to milliseconds; null if invalid. */
export function srtTimeToMs(ts: string): number | null {
  const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return null;
  const [, h, min, s, ms] = m;
  return ((Number(h || 0) * 60 + Number(min)) * 60 + Number(s)) * 1000 +
    Number(ms.padEnd(3, "0"));
}

/** End timestamp (ms) of a cue's "start --> end" line; null if unparsable. */
function cueEndMs(timeLine: string): number | null {
  const parts = timeLine.split("-->");
  if (parts.length < 2) return null;
  // The end side may carry position/style settings after the timestamp.
  return srtTimeToMs(parts[1].trim().split(/\s+/)[0]);
}

/** Format milliseconds back as an SRT timestamp, for log lines. */
function formatMs(ms: number): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(ms / 3600000);
  const min = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${p2(h)}:${p2(min)}:${p2(s)},${String(ms % 1000).padStart(3, "0")}`;
}

export interface SourceCandidate {
  entry: OsEntry;
  rank: number; // 1-based position in the ranked English list
  text: string;
  cueCount: number;
  endMs: number; // last cue's end timestamp
}

const MAX_SOURCE_CANDIDATES = 5;

/**
 * Completeness-aware source selection. The v3 list's top-'g' English entry
 * can be a PARTIAL file (e.g. Breaking Bad S01E01's best pick is a 51-cue
 * stub ending ~00:02:39 while a full ~587-cue track sits in the same list),
 * so download the top few ranked candidates (fetch-only, one attempt each,
 * failures skipped fast) and keep the one with the greatest coverage:
 * primary key = last cue's end time (a full track ends near the runtime;
 * partials end early), tie-break = cue count.
 *
 * Returns null when the list has no English candidates; throws when every
 * candidate download fails — the caller degrades to {"subtitles":[]}.
 */
export async function selectEnglishSource(
  osJson: { subtitles?: OsEntry[] },
  id: string,
): Promise<SourceCandidate | null> {
  const ranked = rankEnglish(osJson).slice(0, MAX_SOURCE_CANDIDATES);
  if (!ranked.length) return null;
  const evaluated: SourceCandidate[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const entry = ranked[i];
    const label = `[en2ko] ${id}: source candidate ${i + 1}/${ranked.length} (g=${entry.g ?? "?"})`;
    try {
      const res = await downloadText(entry.url!, { timeoutMs: 30000 });
      if (res.status !== 200 || !res.text.includes("-->")) {
        console.warn(`${label}: download failed (HTTP ${res.status}) — skipped`);
        continue;
      }
      const blocks = parseSrt(res.text);
      if (!blocks.length) {
        console.warn(`${label}: no cues parsed — skipped`);
        continue;
      }
      const endMs = cueEndMs(blocks[blocks.length - 1].time) ?? 0;
      evaluated.push({
        entry,
        rank: i + 1,
        text: res.text,
        cueCount: blocks.length,
        endMs,
      });
      console.log(`${label}: ${blocks.length} cues, ends ${formatMs(endMs)}`);
    } catch (err) {
      console.warn(
        `${label}: download error (${(err as Error).message}) — skipped`,
      );
    }
  }
  if (!evaluated.length) {
    throw new Error(
      `all ${ranked.length} English source candidate downloads failed`,
    );
  }
  evaluated.sort((a, b) => (b.endMs - a.endMs) || (b.cueCount - a.cueCount));
  const winner = evaluated[0];
  console.log(
    `[en2ko] ${id}: selected source candidate ${winner.rank}/${ranked.length}: ` +
      `${winner.cueCount} cues, ends ${formatMs(winner.endMs)}`,
  );
  return winner;
}

const inFlight = new Map<string, Promise<string>>(); // hash -> translated srt

/**
 * Resolve a title to its translated SRT hash, translating on first use.
 * Returns null when no English track exists; throws on backend failure
 * (the caller degrades to {"subtitles":[]}).
 */
async function resolveHash(type: string, id: string): Promise<string | null> {
  const key = `${type}:${id}`;
  const known = await rawGet(["idx", key]);
  if (typeof known === "string" && (await getCachedText("srt", known))) {
    return known;
  }

  const listUrl = `${OS_V3}/subtitles/${type}/${id}.json`;
  const listRes = await downloadText(listUrl, { timeoutMs: 30000 });
  if (listRes.status !== 200) {
    throw new Error(`OpenSubtitles v3 HTTP ${listRes.status}`);
  }
  const picked = await selectEnglishSource(JSON.parse(listRes.text), id);
  if (!picked) return null;
  const enSrt = picked.text;
  const hash = await sha256(enSrt);
  await rawSet(["idx", key], hash);

  if (await getCachedText("srt", hash)) return hash;

  if (!inFlight.has(hash)) {
    const work = (async () => {
      const t0 = Date.now();
      const koSrt = await translateSrt(enSrt, {
        onProgress: (done, total) =>
          console.log(`[en2ko] ${id}: translated ${done}/${total} lines`),
      });
      await setCachedText("src", hash, enSrt);
      await setCachedText("srt", hash, koSrt);
      console.log(
        `[en2ko] ${id}: cold translation done in ${
          ((Date.now() - t0) / 1000).toFixed(1)
        }s -> kv:srt/${hash}`,
      );
      return koSrt;
    })();
    inFlight.set(hash, work);
    const cleanup = () => inFlight.delete(hash);
    work.then(cleanup, cleanup); // handled on both paths — never unhandled
  }
  await inFlight.get(hash);
  return hash;
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

function jsonResponse(code: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "max-age=0",
    },
  });
}

function baseUrl(req: Request): string {
  const override = Deno.env.get("BASE_URL");
  const base = override || new URL(req.url).origin;
  return base.replace(/\/$/, "");
}

function subsResponse(base: string, hash: string) {
  return {
    subtitles: [
      {
        id: `en2ko-${hash.slice(0, 16)}`,
        url: `${base}/s/${hash}.srt`,
        lang: "kor",
      },
    ],
  };
}

export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  try {
    if (p === "/manifest.json") return jsonResponse(200, MANIFEST);

    if (p.startsWith("/subtitles/") && p.endsWith(".json")) {
      const inner = p.slice("/subtitles/".length, -".json".length);
      const parts = inner.split("/").filter(Boolean);
      const type = decodeURIComponent(parts[0] || "");
      const id = decodeURIComponent(parts[1] || "");
      // parts[2..] = extra (videoHash=..., filename=...) — not needed here.
      if (!type || !id) return jsonResponse(200, { subtitles: [] });
      const t0 = Date.now();
      try {
        const hash = await resolveHash(type, id);
        console.log(
          `[en2ko] /subtitles/${type}/${id} -> ${
            hash ? "ok" : "no-english-track"
          } in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        );
        return jsonResponse(
          200,
          hash ? subsResponse(baseUrl(req), hash) : { subtitles: [] },
        );
      } catch (err) {
        console.error(
          `[en2ko] /subtitles/${type}/${id} FAILED: ${(err as Error).message}`,
        );
        return jsonResponse(200, { subtitles: [] });
      }
    }

    const sMatch = p.match(/^\/s\/([a-f0-9]{64})\.srt$/);
    if (sMatch) {
      const body = await getCachedText("srt", sMatch[1]);
      if (body === null) {
        return new Response("not found", {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        });
      }
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return new Response("not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  } catch (err) {
    console.error("[en2ko] request error:", err);
    return jsonResponse(500, { error: String((err as Error).message || err) });
  }
}

if (import.meta.main) {
  // On Deno Deploy the platform manages the listener — call Deno.serve
  // with no port there. Locally, PORT (default 8000) selects the port.
  const portEnv = Deno.env.get("PORT");
  if (portEnv) {
    Deno.serve({ port: Number(portEnv) }, handler);
  } else {
    Deno.serve(handler);
  }
}
