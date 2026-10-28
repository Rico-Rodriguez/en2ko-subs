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
// AIO — "yeonpil All-in-One" aggregator addon (added 2026-10-22).
//
// One install that replaces the user's whole addon stack:
//   Torrentio (streams) + MediaFusion (streams + watchlist catalogs)
//   + TorBox KR (the bridge logic, live: Korean episodes on their real
//   IMDb episode pages + meta injection for episodes missing upstream)
//   + StremThru Store (TorBox Library catalog + playback for its items)
//   + Live TV — US & Korea (iptv-org country playlists, parsed live)
//   + EN→KO subtitles (the resolveHash pipeline above).
//
// Routes: /aio/<cfg>/manifest.json
//         /aio/<cfg>/{catalog,meta,stream,subtitles}/<type>/<id>[/<extra>].json
// <cfg> = base64url(JSON {t: torrentioBase, m: mediafusionBase,
//         s: stremthruBase}) — bases without a trailing /manifest.json.
// Every upstream leg degrades independently: a dead or slow upstream
// never takes the others down with it.
// ---------------------------------------------------------------------------

interface AioCfg {
  t?: string;
  m?: string;
  s?: string;
}

interface AioShow {
  name: string;
  query: string;
  exclude?: string[];
}

const AIO_SHOWS: AioShow[] = [{"name": "Running Man", "query": "런닝맨"}, {"exclude": ["사랑은 계속된다", "지지고 볶는"], "name": "I Am Solo", "query": "나는 SOLO"}, {"name": "I Am Solo: Love Continues (Nasol Sagye)", "query": "사랑은 계속된다"}, {"name": "I Am Solo spin-off: Jijigo Bokneun Yeohaeng", "query": "지지고 볶는 여행"}, {"name": "Home Alone (I Live Alone)", "query": "나 혼자 산다"}, {"name": "Hangout with Yoo", "query": "놀면 뭐하니"}, {"name": "2 Days & 1 Night", "query": "1박 2일"}, {"name": "Knowing Bros", "query": "아는 형님"}, {"name": "The Manager (Omniscient Interfering View)", "query": "전지적 참견 시점"}, {"name": "My Little Old Boy", "query": "미운 우리 새끼"}, {"name": "Immortal Songs", "query": "불후의 명곡"}, {"name": "King of Mask Singer", "query": "복면가왕"}, {"name": "Heart Signal", "query": "하트시그널"}, {"name": "Heart Pairing", "query": "하트페어링"}, {"name": "Couple Palace", "query": "커플팰리스"}, {"name": "EXchange (Transit Love)", "query": "환승연애"}, {"name": "Love After Divorce (Dol Singles)", "query": "돌싱글즈"}, {"name": "Possessed Love", "query": "신들린 연애"}, {"name": "My Sibling's Romance", "query": "연애남매"}, {"name": "Better Late Than Single", "query": "모태솔로지만 연애는 하고 싶어"}, {"name": "Single's Inferno", "query": "솔로지옥"}, {"name": "Contract Marriage", "query": "계약결혼"}];
const AIO_IMDB: Record<string, string> = {"Running Man": "tt2185037", "I Am Solo": "tt31956936", "I Am Solo: Love Continues (Nasol Sagye)": "tt32270896", "Home Alone (I Live Alone)": "tt7997010", "Hangout with Yoo": "tt15334046", "Knowing Bros": "tt5247622", "My Little Old Boy": "tt33336849", "Heart Signal": "tt16444020", "Heart Pairing": "tt36595271", "Couple Palace": "tt32270478", "Love After Divorce (Dol Singles)": "tt28665617", "My Sibling's Romance": "tt31867638", "Single's Inferno": "tt16283666", "The Manager (Omniscient Interfering View)": "tt15340934", "Better Late Than Single": "tt35668156", "EXchange (Transit Love)": "tt27889213", "Possessed Love": "tt36314699", "Contract Marriage": "tbkr-contract-marriage"};
const AIO_TT2SHOW: Record<string, string> = Object.fromEntries(
  Object.entries(AIO_IMDB).map(([k, v]) => [v, k]),
);

function aioDecodeCfg(seg: string): AioCfg | null {
  try {
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const obj = JSON.parse(atob(b64 + pad));
    const clean = (v: unknown) =>
      typeof v === "string" ? v.replace(/\/+$/, "") : undefined;
    const cfg: AioCfg = { t: clean(obj.t), m: clean(obj.m), s: clean(obj.s) };
    return cfg.t || cfg.m || cfg.s ? cfg : null;
  } catch {
    return null;
  }
}

async function aioFetchJson(
  url: string,
  timeoutMs = 9000,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      await res.text().catch(() => "");
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// --- Korean matching: a port of the watcher's title rules -----------------

function aioNorm(s: string): string {
  return s.replace(/[\s.\-_·,]+/g, "").toLowerCase();
}

function aioTitleMatches(title: string, show: AioShow): boolean {
  const nt = aioNorm(title);
  if (!nt.includes(aioNorm(show.query))) return false;
  for (const ex of show.exclude || []) {
    if (nt.includes(aioNorm(ex))) return false;
  }
  return true;
}

function aioEpisodeNum(title: string): number | null {
  const m = title.match(/[.\s]E(\d{2,4})[.\s]/);
  return m ? parseInt(m[1], 10) : null;
}

// --- StremThru Store (TorBox library by raw filename) ----------------------

interface StoreItem {
  id: string;
  name: string;
}

const storeCache = new Map<string, { at: number; items: StoreItem[] }>();

async function aioStoreItems(sBase: string): Promise<StoreItem[]> {
  const c = storeCache.get(sBase);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.items;
  const items: StoreItem[] = [];
  for (let skip = 0; skip <= 400; skip += 100) {
    const page = await aioFetchJson(
      `${sBase}/catalog/other/st:store:tb${skip ? `/skip=${skip}` : ""}.json`,
      15000,
    );
    const metas = (page?.metas as Record<string, unknown>[] | undefined) || [];
    for (const mt of metas) {
      if (mt?.id && mt?.name) {
        items.push({ id: String(mt.id), name: String(mt.name) });
      }
    }
    if (metas.length < 100) break;
  }
  if (items.length) storeCache.set(sBase, { at: Date.now(), items });
  return items;
}

interface KrEp {
  itemId: string;
  tid: string;
  name: string;
}

/** Map of `${tt}:${episode}` -> the TorBox item holding that episode. */
async function aioKrInventory(sBase: string): Promise<Map<string, KrEp>> {
  const out = new Map<string, KrEp>();
  const items = await aioStoreItems(sBase);
  for (const it of items) {
    for (const show of AIO_SHOWS) {
      if (!aioTitleMatches(it.name, show)) continue;
      const ep = aioEpisodeNum(it.name);
      const tt = AIO_IMDB[show.name];
      if (ep && tt) {
        out.set(`${tt}:${ep}`, {
          itemId: it.id,
          tid: it.id.split(":").pop() || it.id,
          name: it.name,
        });
      }
      break;
    }
  }
  return out;
}

/** Playable URL for a store item, via the store's own meta->stream chain. */
async function aioStoreUrl(sBase: string, item: KrEp): Promise<string | null> {
  const cached = await rawGet(["aio-store-url", item.tid]);
  if (typeof cached === "string" && cached) return cached;
  const meta = await aioFetchJson(
    `${sBase}/meta/other/${item.itemId}.json`,
    15000,
  );
  const videos =
    ((meta?.meta as Record<string, unknown> | undefined)?.videos as
      | Record<string, unknown>[]
      | undefined) || [];
  const vid = videos[0]?.id;
  if (!vid) return null;
  const s = await aioFetchJson(`${sBase}/stream/other/${vid}.json`, 15000);
  const streams = (s?.streams as Record<string, unknown>[] | undefined) || [];
  const url = streams[0]?.url;
  if (typeof url !== "string" || !url) return null;
  await rawSet(["aio-store-url", item.tid], url);
  return url;
}

// --- Live TV (iptv-org US + Korea playlists, parsed live) ------------------

interface TvChan {
  id: string;
  name: string;
  logo: string;
  category: string;
  country: string;
  url: string;
  referer: string;
  agent: string;
}

let tvCache: {
  at: number;
  byId: Map<string, TvChan>;
  byCountry: Map<string, TvChan[]>;
} | null = null;

function aioSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
    "channel";
}

function aioParseM3u(text: string, country: string, out: TvChan[]): void {
  let pending: Partial<TvChan> | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF")) {
      const attrs: Record<string, string> = {};
      for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
      const name = line.includes(",")
        ? line.slice(line.lastIndexOf(",") + 1).trim()
        : "Channel";
      // Listing scrub (2026-10-27, user order): drop religious, news, shop,
      // and legislative feeds. iptv-org tags are ";"-separated and the stored
      // category keeps only the first tag, so the blocklist must match ANY
      // tag, not just the first. YTN is tagged "General" in the playlist but
      // is a news channel, so it is dropped by name.
      const rawTags = (attrs["group-title"] || "").split(";").map((t) =>
        t.trim().toLowerCase()
      );
      const blocked = rawTags.some((t) =>
        ["religious", "news", "shop", "legislative"].includes(t)
      ) || aioStripTags(name) === "YTN";
      if (blocked) {
        pending = null;
        continue;
      }
      let group = (attrs["group-title"] || "").split(";")[0].trim();
      if (!group || group === "Undefined") group = "General";
      pending = {
        name,
        logo: attrs["tvg-logo"] || "",
        category: group,
        country,
        referer: "",
        agent: "",
      };
    } else if (line.startsWith("#EXTVLCOPT:") && pending) {
      const kv = line.slice("#EXTVLCOPT:".length);
      const eq = kv.indexOf("=");
      if (eq > 0) {
        const k = kv.slice(0, eq).trim().toLowerCase();
        const v = kv.slice(eq + 1).trim();
        if (k === "http-referrer") pending.referer = v;
        if (k === "http-user-agent") pending.agent = v;
      }
    } else if (line && !line.startsWith("#") && pending) {
      pending.url = line;
      out.push(pending as TvChan);
      pending = null;
    }
  }
}

/** Build the id/country indexes for a parsed channel list. */
const AIO_EXTRA_CHANS: { name: string; category: string; url: string; logo: string }[] = [
  { name: "KBS Joy", category: "Entertainment", url: "resolver:kbsjoy", logo: "https://upload.wikimedia.org/wikipedia/commons/9/98/KBS_Joy.png" },
  { name: "MBC Every1", category: "Entertainment", url: "resolver:mbcevery1", logo: "https://upload.wikimedia.org/wikipedia/commons/2/2f/MBC_Every1.png" },
];
function aioTvBuild(
  chans: TvChan[],
  at: number,
): NonNullable<typeof tvCache> {
  const seen = new Map<string, number>();
  const byId = new Map<string, TvChan>();
  const byCountry = new Map<string, TvChan[]>();
  for (const ch of chans) {
    let cid = "ftv_" + aioSlug(ch.name);
    const n = (seen.get(cid) || 0) + 1;
    seen.set(cid, n);
    if (n > 1) cid = `${cid}_${n}`;
    ch.id = cid;
    byId.set(cid, ch);
    const arr = byCountry.get(ch.country) || [];
    arr.push(ch);
    byCountry.set(ch.country, arr);
  }
  // Extra channels iptv-org's playlists don't carry (both exist in its
  // channel database but have no stream there). Appended on every build,
  // so the KV cache never needs invalidating for them; skipped if
  // iptv-org adds the channel itself later. Their stream URLs are
  // resolver routes (see aioLiveResolve) that 302 to a freshly resolved
  // official stream, so nothing expirable is stored.
  for (const ex of AIO_EXTRA_CHANS) {
    const slug = aioSlug(ex.name);
    if (chans.some((c) => aioSlug(c.name) === slug)) continue;
    let cid = "ftv_" + slug;
    const n = (seen.get(cid) || 0) + 1;
    seen.set(cid, n);
    if (n > 1) cid = `${cid}_${n}`;
    const ch: TvChan = {
      id: cid,
      name: ex.name,
      logo: ex.logo || "",
      category: ex.category,
      country: "Korea",
      url: ex.url,
      referer: "",
      agent: "",
    };
    byId.set(cid, ch);
    const karr = byCountry.get("Korea") || [];
    karr.push(ch);
    byCountry.set("Korea", karr);
  }
  return { at, byId, byCountry };
}

async function aioTv(): Promise<NonNullable<typeof tvCache>> {
  if (tvCache && Date.now() - tvCache.at < 6 * 3600 * 1000) return tvCache;
  // Persistent cache (Deno KV) for the parsed channel list. The in-memory
  // cache above does not survive isolate recycling, so without this nearly
  // every request re-downloaded and re-parsed both playlists (measured
  // 6-27s) — past the 5s search timeout some clients (NuvioTVOS) enforce,
  // which made live channels invisible in that client's search. With KV,
  // only the first request per 6h window pays the playlist fetch; the rest
  // are cache reads.
  let stale: NonNullable<typeof tvCache> | null = null;
  try {
    const raw = await getCachedText("aio-tv", "v2");
    if (raw) {
      const saved = JSON.parse(raw) as { at: number; chans: TvChan[] };
      if (Array.isArray(saved.chans) && saved.chans.length) {
        const built = aioTvBuild(saved.chans, saved.at);
        if (Date.now() - saved.at < 6 * 3600 * 1000) {
          tvCache = built;
          return tvCache;
        }
        stale = built;
      }
    }
  } catch {
    // corrupt/missing cache: fall through to a live fetch
  }
  const chans: TvChan[] = [];
  const sources: [string, string][] = [
    ["USA", "https://iptv-org.github.io/iptv/countries/us.m3u"],
    ["Korea", "https://iptv-org.github.io/iptv/countries/kr.m3u"],
  ];
  let ok = false;
  for (const [country, url] of sources) {
    try {
      const res = await downloadText(url, { timeoutMs: 30000 });
      if (res.status === 200) {
        aioParseM3u(res.text, country, chans);
        ok = true;
      }
    } catch {
      // keep whatever we have; stale cache below covers total failure
    }
  }
  if (!ok) {
    if (tvCache) return tvCache;
    if (stale) {
      tvCache = stale;
      return tvCache;
    }
  }
  if (chans.length) {
    tvCache = aioTvBuild(chans, Date.now());
    try {
      await setCachedText(
        "aio-tv",
        "v2",
        JSON.stringify({ at: tvCache.at, chans }),
      );
    } catch {
      // cache-save failure must never break the response
    }
  } else if (!tvCache) {
    tvCache = aioTvBuild([], Date.now());
  }
  return tvCache;
}

function aioTvMeta(ch: TvChan, type = "channel"): Record<string, unknown> {
  // Display names drop the playlist tags (" (720p)", "[Not 24/7]") — the
  // card label is the first thing a user reads, and the tags made every
  // channel look like a filename. The dropped info moves to description.
  // posterShape landscape: channel logos are wide/square art, and the
  // default portrait card center-crops them into meaningless slices.
  const flags: string[] = [];
  const qm = ch.name.match(/\((\d+p)\)/);
  if (qm) flags.push(qm[1]);
  if (ch.name.includes("[Not 24/7]")) flags.push("Not 24/7");
  if (ch.name.includes("[Geo-blocked]")) flags.push("Geo-blocked");
  if (ch.url.startsWith("resolver:")) {
    flags.push("Official stream — needs a Korea IP to play");
  }
  const meta: Record<string, unknown> = {
    id: ch.id,
    type,
    name: aioStripTags(ch.name),
    genres: [ch.category],
    posterShape: "landscape",
    description: [ch.category, ...flags].join(" • "),
  };
  if (ch.logo) meta.poster = ch.logo;
  return meta;
}

function aioTvStream(ch: TvChan): Record<string, unknown> {
  const stream: Record<string, unknown> = { url: ch.url, title: ch.name };
  const reqHeaders: Record<string, string> = {};
  if (ch.referer) reqHeaders["Referer"] = ch.referer;
  if (ch.agent) reqHeaders["User-Agent"] = ch.agent;
  if (Object.keys(reqHeaders).length) {
    stream.behaviorHints = { proxyHeaders: { request: reqHeaders } };
  }
  return stream;
}

// --- MediaFusion catalogs (watchlists), merged into our manifest ---------

let mfCatCache: { at: number; cats: Record<string, unknown>[] } | null = null;

async function aioMfCatalogs(
  mBase?: string,
): Promise<Record<string, unknown>[]> {
  if (!mBase) return [];
  // Successes cache for 1h; failures negative-cache for 10 min so a dead
  // MediaFusion never makes the merged manifest slow — its catalogs
  // simply join on a later refresh once it answers again.
  const ttl = mfCatCache?.cats.length ? 3600 * 1000 : 600 * 1000;
  if (mfCatCache && Date.now() - mfCatCache.at < ttl) {
    return mfCatCache.cats;
  }
  const man = await aioFetchJson(`${mBase}/manifest.json`, 60000);
  const cats =
    (man?.catalogs as Record<string, unknown>[] | undefined) || [];
  mfCatCache = { at: Date.now(), cats };
  return cats;
}

// --- AIO manifest ------------------------------------------------------------

async function aioManifest(cfg: AioCfg): Promise<Record<string, unknown>> {
  const catalogs: Record<string, unknown>[] = [
    {
      type: "channel",
      id: "aio_korea_top",
      name: "Korea — Top",
      extra: [{ name: "search", isRequired: false }],
    },
    {
      type: "channel",
      id: "aio_usa_all",
      name: "USA — All",
      extra: [
        { name: "search", isRequired: false },
        {
          name: "genre",
          options: ["Animation", "Auto", "Business", "Classic", "Comedy", "Cooking", "Culture", "Documentary", "Education", "Entertainment", "Family", "General", "Kids", "Lifestyle", "Movies", "Music", "Outdoor", "Relax", "Science", "Series", "Sports", "Travel", "Weather"],
          isRequired: false,
        },
      ],
    },
    {
      type: "channel",
      id: "aio_korea_all",
      name: "Korea — All",
      extra: [
        { name: "search", isRequired: false },
        {
          name: "genre",
          options: ["Education", "Entertainment", "General", "Kids", "Music"],
          isRequired: false,
        },
      ],
    },
    {
      type: "other",
      id: "aio_torbox",
      name: "TorBox Library",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "aio_kr_shows",
      name: "TorBox KR",
      extra: [{ name: "search", isRequired: false }],
    },
    // Pile-in catalogs (2026-10-27): public catalogs proxied into the AIO
    // so no second addon install is needed. Items are tt ids, resolved by
    // the existing meta/stream handlers. No keys anywhere.
    {
      type: "movie",
      id: "aio_cine_movie_top",
      name: "Movies — Popular",
      extra: [
        { name: "search", isRequired: false },
        { name: "genre", options: ["Action", "Adventure", "Animation", "Biography", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Mystery", "Romance", "Sci-Fi", "Sport", "Thriller", "War", "Western"], isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "aio_cine_series_top",
      name: "Series — Popular",
      extra: [
        { name: "search", isRequired: false },
        { name: "genre", options: ["Action", "Adventure", "Animation", "Biography", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Mystery", "Romance", "Sci-Fi", "Sport", "Thriller", "War", "Western", "Reality-TV", "Talk-Show", "Game-Show"], isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "movie",
      id: "aio_cine_movie_rating",
      name: "Movies — Featured",
      extra: [
        { name: "search", isRequired: false },
        { name: "genre", options: ["Action", "Adventure", "Animation", "Biography", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Mystery", "Romance", "Sci-Fi", "Sport", "Thriller", "War", "Western"], isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "aio_cine_series_rating",
      name: "Series — Featured",
      extra: [
        { name: "search", isRequired: false },
        { name: "genre", options: ["Action", "Adventure", "Animation", "Biography", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Mystery", "Romance", "Sci-Fi", "Sport", "Thriller", "War", "Western", "Reality-TV", "Talk-Show", "Game-Show"], isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    { type: "movie", id: "aio_svc_nfx_movie", name: "Netflix" },
    { type: "series", id: "aio_svc_nfx_series", name: "Netflix" },
    { type: "movie", id: "aio_svc_hbm_movie", name: "HBO Max" },
    { type: "series", id: "aio_svc_hbm_series", name: "HBO Max" },
    { type: "movie", id: "aio_svc_dnp_movie", name: "Disney+" },
    { type: "series", id: "aio_svc_dnp_series", name: "Disney+" },
    { type: "movie", id: "aio_svc_amp_movie", name: "Prime Video" },
    { type: "series", id: "aio_svc_amp_series", name: "Prime Video" },
    { type: "movie", id: "aio_svc_atp_movie", name: "Apple TV+" },
    { type: "series", id: "aio_svc_atp_series", name: "Apple TV+" },
  ];
  for (const c of await aioMfCatalogs(cfg.m)) catalogs.push(c);
  return {
    id: "community.yeonpil.aio",
    version: "1.0.0",
    name: "yeonpil All-in-One",
    description:
      "Torrentio + MediaFusion + TorBox KR episodes + TorBox library + Live TV (USA/Korea) + Cinemeta + Streaming service rows + EN→KO subtitles, in one addon.",
    resources: ["catalog", "meta", "stream", "subtitles"],
    types: ["movie", "series", "tv", "channel", "other"],
    idPrefixes: ["tt", "ftv_", "st:", "tbkr"],
    catalogs,
    behaviorHints: { configurable: false },
  };
}

// --- AIO resource handlers ---------------------------------------------------

/** One extra value out of a catalog extra segment ("search=foo&skip=100"). */
function aioExtraVal(extraSeg: string, key: string): string {
  const m = extraSeg.match(new RegExp(`(?:^|&)${key}=([^&]*)`));
  return m ? m[1].trim() : "";
}

/** Loose name key for search: case/space/dot/dash-insensitive, so a typed
 *  query ("i am solo") matches raw release names ("I.Am.Solo..."). */
function aioSearchNorm(s: string): string {
  return s.toLowerCase().replace(/[\s._\-·]+/g, "");
}

/** Curated Korea row: the channels actually watched, first in the menu.
 *  Names match after stripping " (720p)" / "[Not 24/7]" style tags. */
const AIO_KOREA_TOP: string[] = ["KBS Joy", "MBC Every1", "YTN", "TV Chosun", "TV Chosun 2", "EBS 1TV", "EBS 2TV", "EBS English", "EBS Kids", "EBS Plus 1", "EBS Plus 2", "Arirang TV", "Arirang TV HD", "Arirang Radio", "TBS TV", "KTV", "MTN"];
function aioStripTags(name: string): string {
  return name.replace(/\s*\([^)]*\)/g, "").replace(/\s*\[[^\]]*\]/g, "").trim();
}

async function aioCatalog(
  cfg: AioCfg,
  type: string,
  id: string,
  extraSeg: string,
): Promise<Record<string, unknown>> {
  if ((type === "tv" || type === "channel") && (id === "aio_usa_all" || id === "aio_korea_all" || id === "aio_korea_top")) {
    const tv = await aioTv();
    let chans =
      id === "aio_korea_top"
        ? (tv.byCountry.get("Korea") || [])
          .filter((ch) => AIO_KOREA_TOP.includes(aioStripTags(ch.name)))
          .sort((a, b) =>
            AIO_KOREA_TOP.indexOf(aioStripTags(a.name)) -
            AIO_KOREA_TOP.indexOf(aioStripTags(b.name)),
          )
        : tv.byCountry.get(id === "aio_usa_all" ? "USA" : "Korea") || [];
    // Genre filter (declared in the manifest for the All rows).
    const g = aioExtraVal(extraSeg, "genre");
    if (g) {
      chans = chans.filter((ch) => ch.category === g);
    }
    // Clients send search queries to every searchable catalog; without
    // filtering, a search would dump the whole channel list as "results"
    // (the 2026-10-23 search-pollution bug). Filter by channel name.
    const q = aioExtraVal(extraSeg, "search");
    if (q) {
      const nq = aioSearchNorm(q);
      chans = chans.filter((ch) => aioSearchNorm(ch.name).includes(nq));
    }
    return { metas: chans.map((ch) => aioTvMeta(ch, type)) };
  }
  if (type === "other" && id === "aio_torbox" && cfg.s) {
    let items = await aioStoreItems(cfg.s);
    const q = aioExtraVal(extraSeg, "search");
    if (q) {
      const nq = aioSearchNorm(q);
      items = items.filter((it) => aioSearchNorm(it.name).includes(nq));
    }
    const sm = extraSeg.match(/skip=(\d+)/);
    const skip = sm ? Number(sm[1]) : 0;
    return {
      metas: items.slice(skip, skip + 100).map((it) => ({
        id: it.id,
        type: "other",
        name: it.name,
        posterShape: "poster",
      })),
    };
  }
  if (type === "series" && id === "aio_kr_shows") {
    // Korean shows tracked by the watcher, including ones too new for
    // any metadata DB (their pages are synthesized by the bridge).
    const cat = await downloadText(`${TBKR_SURGE}/catalog/series/tbkr.json`, {
      timeoutMs: 15000,
    });
    if (cat.status !== 200) return { metas: [] };
    let metas = (JSON.parse(cat.text).metas || []) as Record<
      string,
      unknown
    >[];
    const q = aioExtraVal(extraSeg, "search");
    if (q) {
      const nq = aioSearchNorm(q.replace(/\+/g, " "));
      metas = metas.filter((m) =>
        aioSearchNorm(String(m.name || "")).includes(nq),
      );
    }
    return { metas };
  }
  // Pile-in proxies (2026-10-27): Cinemeta Popular/Featured + Streaming
  // Catalogs service rows. Upstream catalogs are public JSON, items are tt
  // ids, so meta/stream resolve through the existing handlers. No keys.
  const AIO_CINE_CATS: Record<string, string> = {
    aio_cine_movie_top: "top",
    aio_cine_series_top: "top",
    aio_cine_movie_rating: "imdbRating",
    aio_cine_series_rating: "imdbRating",
  };
  if (AIO_CINE_CATS[id] && (type === "movie" || type === "series")) {
    const proxied = await aioFetchJson(
      `https://v3-cinemeta.strem.io/catalog/${type}/${AIO_CINE_CATS[id]}${extraSeg ? `/${extraSeg}` : ""}.json`,
      30000,
    );
    if (proxied) return proxied;
  }
  const AIO_SVC_CATS: Record<string, string> = {
    aio_svc_nfx_movie: "nfx",
    aio_svc_nfx_series: "nfx",
    aio_svc_hbm_movie: "hbm",
    aio_svc_hbm_series: "hbm",
    aio_svc_dnp_movie: "dnp",
    aio_svc_dnp_series: "dnp",
    aio_svc_amp_movie: "amp",
    aio_svc_amp_series: "amp",
    aio_svc_atp_movie: "atp",
    aio_svc_atp_series: "atp",
  };
  if (AIO_SVC_CATS[id] && (type === "movie" || type === "series")) {
    const proxied = await aioFetchJson(
      `https://7a82163c306e-stremio-netflix-catalog-addon.baby-beamup.club/catalog/${type}/${AIO_SVC_CATS[id]}.json`,
      30000,
    );
    if (proxied) return proxied;
  }
  if (cfg.m) {
    const mfCats = await aioMfCatalogs(cfg.m);
    if (mfCats.some((c) => c.id === id && c.type === type)) {
      const proxied = await aioFetchJson(
        `${cfg.m}/catalog/${type}/${id}${extraSeg ? `/${extraSeg}` : ""}.json`,
        30000,
      );
      if (proxied) return proxied;
    }
  }
  return { metas: [] };
}

async function aioMeta(
  cfg: AioCfg,
  type: string,
  id: string,
  rawId: string = id,
): Promise<Record<string, unknown>> {
  if (type === "tv" || type === "channel") {
    const tv = await aioTv();
    const ch = tv.byId.get(id);
    if (!ch) return { meta: {} };
    return {
      meta: {
        ...aioTvMeta(ch, type),
        description: ch.url.startsWith("resolver:")
          ? `Live channel · official stream (${ch.country} · ${ch.category})`
          : `Live channel · iptv-org (${ch.country} · ${ch.category})`,
      },
    };
  }
  if (type === "other" || id.startsWith("st:")) {
    if (cfg.s) {
      // rawId is forwarded still-encoded: store video ids contain literal
      // "%2F" sequences that must reach StremThru untouched.
      const m = await aioFetchJson(
        `${cfg.s}/meta/${type}/${rawId}.json`,
        15000,
      );
      if (m) return m;
    }
    return { meta: {} };
  }
  if (type === "series" && id.startsWith("tbkr-")) {
    // Bridge-synthesized pages for shows with no metadata-DB entry.
    const r = await downloadText(`${TBKR_SURGE}/meta/series/${id}.json`, {
      timeoutMs: 15000,
    });
    if (r.status !== 200) return { meta: {} };
    return JSON.parse(r.text);
  }
  const cm = await aioFetchJson(
    `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`,
    12000,
  );
  let meta = (cm?.meta as Record<string, unknown> | undefined) || null;
  if (!meta) return { meta: {} };
  if (type === "series" && cfg.s && AIO_TT2SHOW[id]) {
    try {
      const inv = await aioKrInventory(cfg.s);
      const videos = [
        ...((meta.videos as Record<string, unknown>[] | undefined) || []),
      ];
      const have = new Set(
        videos.map((v) => v.episode).filter((e) => typeof e === "number"),
      );
      let added = false;
      for (const [key, item] of inv) {
        const [tt, epStr] = key.split(":");
        const ep = Number(epStr);
        if (tt !== id || have.has(ep)) continue;
        const dm = item.name.match(/\.(\d{2})(\d{2})(\d{2})\./);
        const video: Record<string, unknown> = {
          id: `${id}:1:${ep}`,
          season: 1,
          episode: ep,
          title: `Episode ${ep}`,
          overview: "",
        };
        if (dm) {
          video.released = `20${dm[1]}-${dm[2]}-${dm[3]}T00:00:00.000Z`;
        }
        videos.push(video);
        added = true;
      }
      if (added) {
        videos.sort(
          (a, b) =>
            Number(a.season || 0) - Number(b.season || 0) ||
            Number(a.episode || 0) - Number(b.episode || 0),
        );
        meta = { ...meta, videos };
      }
    } catch {
      // Korean injection is best-effort; Cinemeta alone is still correct.
    }
  }
  return { meta };
}

async function aioStream(
  cfg: AioCfg,
  type: string,
  id: string,
  rawId: string = id,
  req?: Request,
): Promise<Record<string, unknown>> {
  if (type === "tv" || type === "channel") {
    const tv = await aioTv();
    const ch = tv.byId.get(id);
    if (!ch) return { streams: [] };
    if (ch.url.startsWith("resolver:") && req) {
      const key = ch.url.slice("resolver:".length);
      return {
        streams: [{ url: `${baseUrl(req)}/aio/live/${key}`, title: ch.name }],
      };
    }
    return { streams: [aioTvStream(ch)] };
  }
  if (type === "other" || id.startsWith("st:")) {
    if (cfg.s) {
      const s = await aioFetchJson(
        `${cfg.s}/stream/${type}/${rawId}.json`,
        15000,
      );
      if (s) return s;
    }
    return { streams: [] };
  }
  // IMDb ids: TorBox KR (own library) first, then Torrentio, then
  // MediaFusion — merged, deduped, each leg independent.
  let kr: Record<string, unknown>[] = [];
  if (type === "series" && cfg.s) {
    const parts = id.split(":");
    if (parts.length === 3) {
      try {
        const inv = await aioKrInventory(cfg.s);
        const item = inv.get(`${parts[0]}:${Number(parts[2])}`);
        if (item) {
          const u = await aioStoreUrl(cfg.s, item);
          if (u) kr = [{ name: "⚡ TorBox KR", title: item.name, url: u }];
        }
      } catch {
        // fall through to the upstream legs
      }
    }
  }
  const [tor, mf] = await Promise.all([
    cfg.t
      ? aioFetchJson(`${cfg.t}/stream/${type}/${id}.json`, 9000)
      : Promise.resolve(null),
    cfg.m
      ? aioFetchJson(`${cfg.m}/stream/${type}/${id}.json`, 9000)
      : Promise.resolve(null),
  ]);
  const merged: Record<string, unknown>[] = [
    ...kr,
    ...((tor?.streams as Record<string, unknown>[] | undefined) || []),
    ...((mf?.streams as Record<string, unknown>[] | undefined) || []),
  ];
  const seenKeys = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const s of merged) {
    const url = typeof s?.url === "string" ? s.url : "";
    if (url.includes("/static/exceptions/")) continue; // upstream error card
    const key =
      url || `${s?.infoHash || ""}:${s?.fileIdx ?? ""}:${s?.name || ""}`;
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push(s);
    if (out.length >= 120) break;
  }
  return { streams: out };
}

async function aioSubtitles(
  req: Request,
  type: string,
  id: string,
): Promise<Record<string, unknown>> {
  if (!type || !id) return { subtitles: [] };
  try {
    const hash = await resolveHash(type, id);
    return hash ? subsResponse(baseUrl(req), hash) : { subtitles: [] };
  } catch {
    return { subtitles: [] };
  }
}

async function handleAio(req: Request, p: string): Promise<Response | null> {
  if (!p.startsWith("/aio/")) return null;
  const seg = p.slice("/aio/".length).split("/").filter(Boolean);
  const cfg = aioDecodeCfg(seg[0] || "");
  if (!cfg) return new Response("not found", { status: 404 });
  try {
    if (seg[1] === "manifest.json") {
      return jsonResponse(200, await aioManifest(cfg));
    }
    const resource = seg[1];
    const type = decodeURIComponent(seg[2] || "");
    let id = "";
    let rawId = "";
    let extraSeg = "";
    if (seg.length === 4) {
      rawId = (seg[3] || "").replace(/\.json$/, "");
      id = decodeURIComponent(rawId);
    } else if (seg.length >= 5) {
      rawId = seg[3] || "";
      id = decodeURIComponent(rawId);
      extraSeg = decodeURIComponent(
        (seg[seg.length - 1] || "").replace(/\.json$/, ""),
      );
    }
    if (!resource || !type || !id) return jsonResponse(404, {});
    if (resource === "catalog") {
      return jsonResponse(200, await aioCatalog(cfg, type, id, extraSeg));
    }
    if (resource === "meta") {
      return jsonResponse(200, await aioMeta(cfg, type, id, rawId));
    }
    if (resource === "stream") {
      return jsonResponse(200, await aioStream(cfg, type, id, rawId, req));
    }
    if (resource === "subtitles") {
      return jsonResponse(200, await aioSubtitles(req, type, id));
    }
    return new Response("not found", { status: 404 });
  } catch (err) {
    console.error("[aio] request error:", err);
    const empty: Record<string, unknown> =
      seg[1] === "catalog"
        ? { metas: [] }
        : seg[1] === "meta"
        ? { meta: {} }
        : seg[1] === "subtitles"
        ? { subtitles: [] }
        : { streams: [] };
    return jsonResponse(200, empty);
  }
}

/** Resolve a resolver: channel to a fresh official stream URL (302).
 * KBS Joy: KBS's official on-air API returns a signed CloudFront URL
 * (verified playable from a US IP). MBC Every1: MBC's official media
 * API returns the stream URL, but geo-blocks non-Korean IPs, so this
 * 502s outside Korea by MBC's own decision, not ours. */
async function aioLiveResolve(key: string): Promise<Response> {
  const fail = () =>
    new Response("stream unavailable", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });
  try {
    let target: string | null = null;
    if (key === "kbsjoy") {
      const res = await downloadText(
        "https://mn.kbs.co.kr/api/getNewsLiveStreamUrl?channel=kbsnjoy",
        { timeoutMs: 15000 },
      );
      if (res.status === 200) {
        const j = JSON.parse(res.text) as {
          data?: { streamUrl?: string };
        };
        target = j.data?.streamUrl || null;
      }
    } else if (key === "mbcevery1") {
      const res = await fetch(
        `https://mediaapi.imbc.com/Player/OnAirPlusURLUtil?ch=2&type=PC&t=${Date.now()}`,
        {
          headers: {
            Referer: "https://onair.imbc.com/",
            "User-Agent": UA,
          },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (res.status === 200) {
        const j = (await res.json()) as {
          MediaInfo?: { MediaURL?: string };
        };
        target = j.MediaInfo?.MediaURL || null;
      }
    } else {
      return new Response("not found", { status: 404 });
    }
    if (!target) return fail();
    return new Response(null, {
      status: 302,
      headers: { Location: target, "Cache-Control": "no-store" },
    });
  } catch {
    return fail();
  }
}

// ---------------------------------------------------------------------------
// TorBox KR Bridge (dynamic host) — same data as the surge static site,
// plus a real search filter for catalog queries. Install URL:
// https://<this-host>/tbkr/manifest.json
// ---------------------------------------------------------------------------

const TBKR_SURGE = "https://tbkr-bridge-9d41.surge.sh";

async function handleTbkr(req: Request, p: string): Promise<Response | null> {
  const seg = p.split("/").filter(Boolean);
  if (seg[0] !== "tbkr") return null;
  if (seg[1] === "manifest.json") {
    return jsonResponse(200, {
      id: "local.tbkr.bridge",
      version: "1.1.0",
      name: "TorBox KR Bridge",
      description: "Your TorBox Korean episodes, attached to their real episode pages.",
      resources: ["stream", "meta", "catalog"],
      types: ["series"],
      idPrefixes: ["tt", "tbkr"],
      catalogs: [
        {
          type: "series",
          id: "tbkr",
          name: "TorBox KR",
          extra: [{ name: "search", isRequired: false }],
        },
      ],
      behaviorHints: { configurable: false },
    });
  }
  if (seg[1] === "catalog") {
    const cat = await downloadText(`${TBKR_SURGE}/catalog/series/tbkr.json`, {
      timeoutMs: 15000,
    });
    if (cat.status !== 200) return jsonResponse(200, { metas: [] });
    let metas = (JSON.parse(cat.text).metas || []) as {
      name?: string;
    }[];
    // Search value can arrive as a path segment (Stremio style:
    // .../search=<q>.json, optionally followed by &skip=...), with "+"
    // or "%20" for spaces, or as a plain query string — accept all.
    const pathMatch = p.match(/search=([^/&#?]+)/);
    const queryMatch = new URL(req.url).searchParams.get("search");
    const rawQ = pathMatch
      ? pathMatch[1].replace(/\.json$/, "")
      : queryMatch;
    if (rawQ) {
      const q = decodeURIComponent(rawQ.replace(/\+/g, " ")).toLowerCase();
      metas = metas.filter((m) => (m.name || "").toLowerCase().includes(q));
    }
    return jsonResponse(200, { metas });
  }
  if (seg[1] === "meta" || seg[1] === "stream") {
    const id = decodeURIComponent((seg[3] || "").replace(/\.json$/, ""));
    if (!id) return jsonResponse(200, seg[1] === "meta" ? { meta: {} } : { streams: [] });
    const r = await downloadText(
      `${TBKR_SURGE}/${seg[1]}/series/${id}.json`,
      { timeoutMs: 15000 },
    );
    if (r.status !== 200) {
      return jsonResponse(200, seg[1] === "meta" ? { meta: {} } : { streams: [] });
    }
    return jsonResponse(200, JSON.parse(r.text));
  }
  return null;
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
    // Config-less live resolvers for channels iptv-org doesn't stream.
    if (p === "/aio/live/kbsjoy") return await aioLiveResolve("kbsjoy");
    if (p === "/aio/live/mbcevery1") return await aioLiveResolve("mbcevery1");

    // TorBox KR Bridge (dynamic host).
    if (p.startsWith("/tbkr/")) {
      const tbkrRes = await handleTbkr(req, p);
      if (tbkrRes) return tbkrRes;
    }

    const aioRes = await handleAio(req, p);
    if (aioRes) return aioRes;

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
