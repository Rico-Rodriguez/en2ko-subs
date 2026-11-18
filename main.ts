/**
 * main.ts — yeonpil All-in-One Stremio addon + EN→KO subtitles addon.
 *
 * Runs on the Oracle VM (goy-crew-phone) as aio-addon.service on port 7861,
 * behind Caddy at https://aio.129-146-48-232.sslip.io. Single file on
 * purpose: deploying is "copy this file to /home/ubuntu/aio-addon/main.ts
 * and restart the service".
 *
 * Run:  PORT=7861 deno run --allow-net --allow-env --unstable-kv main.ts
 *
 * ROUTES (unchanged from the pre-refactor file — install URLs keep working)
 *   /aio/<cfg>/manifest.json
 *   /aio/<cfg>/{catalog,meta,stream,subtitles}/<type>/<id>[/<extra>].json
 *   /aio/live/{kbsjoy,mbcevery1}        302 to a fresh official stream
 *   /tbkr/{manifest.json,catalog,meta,stream}/...   TorBox KR bridge
 *   /manifest.json, /subtitles/<type>/<id>[/<extra>].json, /s/<hash>.srt
 *                                       standalone EN→KO subtitles addon
 *   /health                             status page (new)
 *   <cfg> = base64url(JSON {t: torrentioBase, m: mediafusionBase,
 *           s: stremthruBase}), bases without a trailing /manifest.json.
 *
 * ENV
 *   PORT            listen port (unset → Deno default)
 *   BASE_URL        public base for self-links (default: request origin)
 *   EN2KO_NO_KV=1   in-memory cache only
 *   BRIDGE_PUBLIC   public NBA-bridge base (default https://129-146-48-232.sslip.io)
 *   BRIDGE_FETCH    base(s) the AIO itself uses to reach the bridge,
 *                   comma-separated, tried in order (default: localhost,
 *                   the VM's private IP, then the public base)
 *   AIO_WARM=0      disable the background cache warmers
 *
 * LAYOUT
 *   1. Config & constants          6. Live TV
 *   2. HTTP + cache primitives     7. TorBox store / KR episodes
 *   3. Subtitle translation        8. NBA bridge (CNCVerse)
 *   4. Subtitle source + resolve   9. AIO manifest / catalog / meta / stream
 *   5. AIO config + helpers        10. Router, warmers, startup
 *
 * Every upstream leg degrades independently: a dead or slow upstream never
 * takes the others down with it. Caches are stale-while-revalidate: once
 * something has loaded once, users get the cached copy instantly and the
 * refresh happens in the background.
 */

// ===========================================================================
// 1. Config & constants
// ===========================================================================

type Json = Record<string, unknown>;

const env = (k: string) => {
  try {
    return Deno.env.get(k) || undefined;
  } catch {
    return undefined;
  }
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const OS_V3 = "https://opensubtitles-v3.strem.io";
const CINEMETA = "https://v3-cinemeta.strem.io";
const SVC_CATALOGS =
  "https://7a82163c306e-stremio-netflix-catalog-addon.baby-beamup.club";
const TBKR_SURGE = "https://tbkr-bridge-9d41.surge.sh";
const IPTV_SOURCES: [country: string, url: string][] = [
  ["USA", "https://iptv-org.github.io/iptv/countries/us.m3u"],
  ["Korea", "https://iptv-org.github.io/iptv/countries/kr.m3u"],
];

// CNCVerse NBA bridge — same VM (systemd cncverse-bridge, port 7860).
// The bridge writes its INTERNAL base into stream/proxy URLs (its own
// tunnel rewrite is dead code on the JVM build), so every bridge response
// gets INTERNAL rewritten to PUBLIC before it reaches a client.
const BRIDGE_PUBLIC = (env("BRIDGE_PUBLIC") || "https://129-146-48-232.sslip.io")
  .replace(/\/+$/, "");
const BRIDGE_INTERNAL = "http://10.0.0.94:7860";
const BRIDGE_FETCH_BASES: string[] = [
  ...new Set(
    (env("BRIDGE_FETCH") ||
      `http://127.0.0.1:7860,${BRIDGE_INTERNAL},${BRIDGE_PUBLIC}`)
      .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean),
  ),
];

// Bridge catalogs folded into the AIO, one row each. Streams verified live
// 2026-11-07. Excluded (their loadLinks return zero streams):
//   cnc_DaddyLiveProvider_DaddyLive_other — channel extraction fails
//   cnc_BasketballReplays_BasketballReplays_other — site times out from VM
// Re-add one by appending it here if it starts working.
const BRIDGE_CATS: { id: string; name: string }[] = [
  { id: "cnc_SKTechProvider_SKTechLiveEvents_other", name: "NBA · SKTech Live" },
  { id: "cnc_SportzxProvider_SportzXLiveEvents_other", name: "NBA · SportzX Live" },
  { id: "cnc_SportzxProvider_SportzXHighlights_other", name: "NBA · SportzX Highlights" },
  { id: "cnc_PlayFyProvider_PlayFyLiveEvents_other", name: "NBA · PlayFy Live" },
  { id: "cnc_PlayFyProvider_PlayFyHighlights_other", name: "NBA · PlayFy Highlights" },
  { id: "cnc_LivXowProvider_LivXowLiveEvents_other", name: "NBA · LivXow Live" },
  { id: "cnc_LivXowProvider_LivXowHighlights_other", name: "NBA · LivXow Highlights" },
];

// Korean shows tracked from the TorBox library, matched by release name.
interface KrShow {
  name: string;
  query: string;
  imdb?: string;
  exclude?: string[];
}
const KR_SHOWS: KrShow[] = [
  { name: "Running Man", query: "런닝맨", imdb: "tt2185037" },
  { name: "I Am Solo", query: "나는 SOLO", imdb: "tt31956936", exclude: ["사랑은 계속된다", "지지고 볶는"] },
  { name: "I Am Solo: Love Continues (Nasol Sagye)", query: "사랑은 계속된다", imdb: "tt32270896" },
  { name: "I Am Solo spin-off: Jijigo Bokneun Yeohaeng", query: "지지고 볶는 여행" },
  { name: "Home Alone (I Live Alone)", query: "나 혼자 산다", imdb: "tt7997010" },
  { name: "Hangout with Yoo", query: "놀면 뭐하니", imdb: "tt15334046" },
  { name: "2 Days & 1 Night", query: "1박 2일" },
  { name: "Knowing Bros", query: "아는 형님", imdb: "tt5247622" },
  { name: "The Manager (Omniscient Interfering View)", query: "전지적 참견 시점", imdb: "tt15340934" },
  { name: "My Little Old Boy", query: "미운 우리 새끼", imdb: "tt33336849" },
  { name: "Immortal Songs", query: "불후의 명곡" },
  { name: "King of Mask Singer", query: "복면가왕" },
  { name: "Heart Signal", query: "하트시그널", imdb: "tt16444020" },
  { name: "Heart Pairing", query: "하트페어링", imdb: "tt36595271" },
  { name: "Couple Palace", query: "커플팰리스", imdb: "tt32270478" },
  { name: "EXchange (Transit Love)", query: "환승연애", imdb: "tt27889213" },
  { name: "Love After Divorce (Dol Singles)", query: "돌싱글즈", imdb: "tt28665617" },
  { name: "Possessed Love", query: "신들린 연애", imdb: "tt36314699" },
  { name: "My Sibling's Romance", query: "연애남매", imdb: "tt31867638" },
  { name: "Better Late Than Single", query: "모태솔로지만 연애는 하고 싶어", imdb: "tt35668156" },
  { name: "Single's Inferno", query: "솔로지옥", imdb: "tt16283666" },
  { name: "Contract Marriage", query: "계약결혼", imdb: "tbkr-contract-marriage" },
];
const KR_IMDB_IDS = new Set(KR_SHOWS.map((s) => s.imdb).filter(Boolean));

// Live TV: curated Korea row, in menu order (names after tag stripping).
const KOREA_TOP: string[] = [
  "KBS Joy", "MBC Every1", "YTN", "TV Chosun", "TV Chosun 2", "EBS 1TV",
  "EBS 2TV", "EBS English", "EBS Kids", "EBS Plus 1", "EBS Plus 2",
  "Arirang TV", "Arirang TV HD", "Arirang Radio", "TBS TV", "KTV", "MTN",
];
// Channels iptv-org lists without a stream; served via /aio/live resolvers.
const EXTRA_CHANNELS = [
  { name: "KBS Joy", category: "Entertainment", url: "resolver:kbsjoy", logo: "https://upload.wikimedia.org/wikipedia/commons/9/98/KBS_Joy.png" },
  { name: "MBC Every1", category: "Entertainment", url: "resolver:mbcevery1", logo: "https://upload.wikimedia.org/wikipedia/commons/2/2f/MBC_Every1.png" },
];
// Listing scrub (2026-10-27): drop religious, news, shop, legislative.
const TV_BLOCKED_TAGS = ["religious", "news", "shop", "legislative"];
const TV_BLOCKED_NAMES = ["YTN"]; // tagged "General" upstream but it's news
const USA_GENRES = ["Animation", "Auto", "Business", "Classic", "Comedy", "Cooking", "Culture", "Documentary", "Education", "Entertainment", "Family", "General", "Kids", "Lifestyle", "Movies", "Music", "Outdoor", "Relax", "Science", "Series", "Sports", "Travel", "Weather"];
const KOREA_GENRES = ["Education", "Entertainment", "General", "Kids", "Music"];

const MOVIE_GENRES = ["Action", "Adventure", "Animation", "Biography", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Mystery", "Romance", "Sci-Fi", "Sport", "Thriller", "War", "Western"];
const SERIES_GENRES = [...MOVIE_GENRES, "Reality-TV", "Talk-Show", "Game-Show"];

// Cinemeta rows proxied into the AIO: aio id -> Cinemeta catalog id.
const CINE_CATS: { id: string; type: string; name: string; upstream: string }[] = [
  { id: "aio_cine_movie_top", type: "movie", name: "Movies — Popular", upstream: "top" },
  { id: "aio_cine_series_top", type: "series", name: "Series — Popular", upstream: "top" },
  { id: "aio_cine_movie_rating", type: "movie", name: "Movies — Featured", upstream: "imdbRating" },
  { id: "aio_cine_series_rating", type: "series", name: "Series — Featured", upstream: "imdbRating" },
];
// Streaming-service rows (Streaming Catalogs addon): code, display name.
const SVC_CATS: [code: string, name: string][] = [
  ["nfx", "Netflix"], ["hbm", "HBO Max"], ["dnp", "Disney+"],
  ["amp", "Prime Video"], ["atp", "Apple TV+"],
];

const MAX_STREAMS = 120;

// ===========================================================================
// 2. HTTP + cache primitives
// ===========================================================================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class TimeoutError extends Error {
  constructor() {
    super("timeout");
  }
}

/**
 * Fetch a URL as text with a HARD timeout. AbortSignal.timeout alone did
 * not reliably stop a stalled fetch (a 30s signal let one run 37s), so the
 * whole fetch+body is raced against a timer, and the request is aborted
 * when the timer wins so the socket is released. Throws on network error
 * or timeout; HTTP errors come back as a status.
 */
export async function downloadText(
  url: string,
  { timeoutMs = 30000, headers = {} }: {
    timeoutMs?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; text: string }> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      ac.abort();
      rej(new TimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, {
          headers: { "User-Agent": UA, ...headers },
          signal: ac.signal,
        });
        return { status: res.status, text: await res.text() };
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** GET JSON; null on any failure (network, timeout, non-2xx, bad JSON). */
async function fetchJson(url: string, timeoutMs = 9000): Promise<Json | null> {
  try {
    const r = await downloadText(url, {
      timeoutMs,
      headers: { Accept: "application/json" },
    });
    if (r.status < 200 || r.status >= 300) return null;
    const j = JSON.parse(r.text);
    return j && typeof j === "object" ? j as Json : null;
  } catch {
    return null;
  }
}

const listOf = (v: unknown): Json[] => Array.isArray(v) ? v as Json[] : [];

// --- Persistent store: Deno KV, in-memory Map fallback ---------------------
// KV values are capped at 64 KiB, so long texts are stored as a chunk
// count + chunks split on UTF-8 byte boundaries. Key prefixes "idx", "src",
// "srt" hold the translated-subtitle cache and are kept from the old file.

interface KvLike {
  get(key: unknown[]): Promise<{ value: unknown }>;
  set(key: unknown[], value: unknown): Promise<unknown>;
}

const memStore = new Map<string, unknown>();
let kvPromise: Promise<KvLike | null> | null = null;

function getKv(): Promise<KvLike | null> {
  kvPromise ??= (async () => {
    if (env("EN2KO_NO_KV") === "1") return null;
    try {
      const openKv =
        (Deno as unknown as { openKv?: () => Promise<KvLike> }).openKv;
      if (!openKv) return null;
      const kv = await openKv();
      console.log("[aio] cache: Deno KV");
      return kv;
    } catch (err) {
      console.warn(`[aio] Deno KV unavailable (${(err as Error).message}); memory cache only`);
      return null;
    }
  })();
  return kvPromise;
}

async function rawGet(parts: string[]): Promise<unknown> {
  const kv = await getKv();
  if (kv) return (await kv.get(parts)).value;
  return memStore.get(JSON.stringify(parts)) ?? null;
}

async function rawSet(parts: string[], value: unknown): Promise<void> {
  const kv = await getKv();
  if (kv) await kv.set(parts, value);
  else memStore.set(JSON.stringify(parts), value);
}

const CHUNK_BYTES = 60000;

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

export async function setCachedText(prefix: string, hash: string, text: string): Promise<void> {
  const chunks = splitByBytes(text, CHUNK_BYTES);
  // Chunks first, count last: a reader never sees a count without its data.
  for (let i = 0; i < chunks.length; i++) {
    await rawSet([prefix, hash, "c", String(i)], chunks[i]);
  }
  await rawSet([prefix, hash, "n"], chunks.length);
}

export async function getCachedText(prefix: string, hash: string): Promise<string | null> {
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

// --- Stale-while-revalidate cache -------------------------------------------

interface Entry<T> {
  at: number;
  v: T | null; // null = negative entry (upstream failed / empty)
}

interface CacheSpec {
  /** Fresh for this long: returned without touching the upstream. */
  ttl: number;
  /** After ttl, still served for this long while a refresh runs. */
  stale?: number;
  /** With a stale copy: wait this long for the refresh before serving
   *  stale (0/undefined = serve stale immediately). */
  wait?: number;
  /** With no copy at all: give up after this long (refresh keeps going
   *  in the background). Undefined = wait for the loader. */
  coldWait?: number;
  /** Failed/empty loads are remembered this long (default 1 min). */
  negTtl?: number;
  /** Also keep in Deno KV so it survives a restart. */
  persist?: boolean;
}

const MEM_MAX = 4000;
const mem = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

function memSet(key: string, e: Entry<unknown>) {
  mem.delete(key);
  mem.set(key, e);
  while (mem.size > MEM_MAX) mem.delete(mem.keys().next().value!);
}

async function kvLoad<T>(key: string): Promise<Entry<T> | undefined> {
  if (!(await getKv())) return undefined;
  try {
    const raw = await getCachedText("c2", await sha256(key));
    return raw ? JSON.parse(raw) as Entry<T> : undefined;
  } catch {
    return undefined;
  }
}

async function kvSave(key: string, e: Entry<unknown>) {
  if (!(await getKv())) return;
  try {
    await setCachedText("c2", await sha256(key), JSON.stringify(e));
  } catch (err) {
    console.warn(`[aio] cache save failed for ${key}: ${(err as Error).message}`);
  }
}

function raceDeadline<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms))),
  ]).finally(() => clearTimeout(timer));
}

function refresh<T>(
  key: string,
  spec: CacheSpec,
  load: () => Promise<T | null>,
  prev: Entry<T> | undefined,
): Promise<T | null> {
  const running = inflight.get(key) as Promise<T | null> | undefined;
  if (running) return running;
  const p = (async () => {
    let v: T | null = null;
    try {
      v = await load();
    } catch (err) {
      console.warn(`[aio] load failed for ${key}: ${(err as Error).message}`);
    }
    if (v !== null) {
      const e = { at: Date.now(), v };
      memSet(key, e);
      if (spec.persist) await kvSave(key, e);
    } else if (!prev || prev.v === null) {
      memSet(key, { at: Date.now(), v: null });
    } // else: keep the older good copy; it stays servable within `stale`
    return v;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Get `key` through the cache, loading with `load` when needed. Loaders
 *  return null for "nothing usable" (never cached as a success). */
async function cached<T>(
  key: string,
  spec: CacheSpec,
  load: () => Promise<T | null>,
): Promise<T | null> {
  let e = mem.get(key) as Entry<T> | undefined;
  if (!e && spec.persist) {
    e = await kvLoad<T>(key);
    if (e) memSet(key, e);
  }
  const age = e ? Date.now() - e.at : Infinity;
  if (e && e.v === null && age < (spec.negTtl ?? MIN)) return null;
  if (e && e.v !== null && age < spec.ttl) return e.v;

  const p = refresh(key, spec, load, e);
  if (e && e.v !== null && age < spec.ttl + (spec.stale ?? 0)) {
    if (!spec.wait) return e.v;
    return (await raceDeadline(p, spec.wait)) ?? e.v;
  }
  if (spec.coldWait) return (await raceDeadline(p, spec.coldWait)) ?? null;
  return await p;
}

/** Run `fn` over `items` with at most `n` in flight. */
async function mapLimit<A, B>(items: A[], n: number, fn: (a: A) => Promise<B>): Promise<B[]> {
  const out = new Array<B>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ===========================================================================
// 3. Subtitle translation (EN→KO via the free gtx endpoint)
// ===========================================================================

export const GT_ENDPOINT = "https://translate.googleapis.com/translate_a/single";

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SrtBlock {
  index: string;
  time: string;
  lines: string[];
}

/** Parse SRT text into blocks; non-block preamble (e.g. WEBVTT) is dropped. */
export function parseSrt(text: string): SrtBlock[] {
  const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^﻿/, "");
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
  return blocks.map((b) => [b.index, b.time, ...b.lines].join("\r\n")).join("\r\n\r\n") + "\r\n";
}

export interface TranslateOpts {
  sl?: string;
  tl?: string;
  chunkChars?: number;
  interChunkDelayMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  onProgress?: (done: number, total: number) => void;
  /** Injectable backend (joined chunk text -> translated text), for tests. */
  translateFn?: (text: string, opts: { sl: string; tl: string }) => Promise<string>;
}

interface GtxError extends Error {
  status?: number;
}

async function gtxTranslate(text: string, { sl = "en", tl = "ko" } = {}): Promise<string> {
  const params = new URLSearchParams({ client: "gtx", sl, tl, dt: "t", ie: "UTF-8", oe: "UTF-8", q: text });
  const { status, text: body } = await downloadText(`${GT_ENDPOINT}?${params}`, { timeoutMs: 30000 });
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
    const err: GtxError = new Error("gtx returned non-JSON (rate-limit interstitial)");
    err.status = 429;
    throw err;
  }
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("gtx unexpected response shape");
  return (data[0] as unknown[])
    .map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
    .join("");
}

async function gtxWithRetries(
  text: string,
  opts: { sl?: string; tl?: string },
  { maxRetries = 5, baseDelayMs = 4000 } = {},
): Promise<string> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await gtxTranslate(text, opts);
    } catch (err) {
      lastErr = err as Error;
      if (attempt < maxRetries) {
        const wait = Math.min(baseDelayMs * 2 ** attempt, 60000);
        console.warn(`[en2ko] gtx attempt ${attempt + 1} failed (${lastErr.message}); retrying in ${(wait / 1000).toFixed(0)}s`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

/**
 * Translate independent text items (subtitle lines), preserving count and
 * order. Items are batched into newline-joined chunks under the endpoint's
 * query-length limit; a chunk whose line count comes back wrong is retried
 * item by item.
 */
export async function translateItems(items: string[], opts: TranslateOpts = {}): Promise<string[]> {
  const { chunkChars = 4000, interChunkDelayMs = 700, maxRetries, baseDelayMs, onProgress } = opts;
  const backend = opts.translateFn ??
    ((t: string, o: { sl: string; tl: string }) => gtxWithRetries(t, o, { maxRetries, baseDelayMs }));
  const langOpts = { sl: opts.sl ?? "en", tl: opts.tl ?? "ko" };

  const results = new Array<string>(items.length);
  const todo: number[] = [];
  items.forEach((it, i) => {
    // Items with no letters/digits ("♪", "...", "--") pass through.
    if (/[\p{L}\p{N}]/u.test(it)) todo.push(i);
    else results[i] = it;
  });

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
    // Hard failures propagate: retrying item-by-item against a rate limit
    // would only multiply the wait.
    const parts = (await backend(chunk.map((i) => items[i]).join("\n"), langOpts)).split("\n");
    if (parts.length === chunk.length) {
      chunk.forEach((idx, k) => (results[idx] = parts[k].trim()));
    } else {
      for (const idx of chunk) results[idx] = await backend(items[idx], langOpts);
    }
    done += chunk.length;
    onProgress?.(done, todo.length);
    if (interChunkDelayMs) await sleep(interChunkDelayMs);
  }
  return results;
}

/** Translate a whole SRT; indices and timestamps never reach the translator. */
export async function translateSrt(enSrtText: string, opts: TranslateOpts = {}): Promise<string> {
  const blocks = parseSrt(enSrtText);
  const flat: string[] = [];
  const positions: [number, number][] = [];
  blocks.forEach((b, bi) =>
    b.lines.forEach((line, li) => {
      positions.push([bi, li]);
      flat.push(line);
    })
  );
  const translated = await translateItems(flat, opts);
  positions.forEach(([bi, li], k) => (blocks[bi].lines[li] = translated[k]));
  return serializeSrt(blocks);
}

// ===========================================================================
// 4. Subtitle source selection + resolve
// ===========================================================================

interface OsEntry {
  lang?: string;
  g?: string | number;
  url?: string;
}

/** English entries, best first: 'g' tier descending, then list order. */
export function rankEnglish(osJson: { subtitles?: OsEntry[] }): OsEntry[] {
  const subs = (osJson.subtitles || []).filter((s) => (s.lang === "eng" || s.lang === "en") && s.url);
  subs.sort((a, b) => Number(b.g || 0) - Number(a.g || 0));
  return subs;
}

export function pickEnglish(osJson: { subtitles?: OsEntry[] }): OsEntry | null {
  return rankEnglish(osJson)[0] ?? null;
}

export function srtTimeToMs(ts: string): number | null {
  const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return null;
  const [, h, min, s, ms] = m;
  return ((Number(h || 0) * 60 + Number(min)) * 60 + Number(s)) * 1000 + Number(ms.padEnd(3, "0"));
}

function cueEndMs(timeLine: string): number | null {
  const parts = timeLine.split("-->");
  return parts.length < 2 ? null : srtTimeToMs(parts[1].trim().split(/\s+/)[0]);
}

function formatMs(ms: number): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(Math.floor(ms / 3600000))}:${p2(Math.floor(ms / 60000) % 60)}:${p2(Math.floor(ms / 1000) % 60)},${String(ms % 1000).padStart(3, "0")}`;
}

export interface SourceCandidate {
  entry: OsEntry;
  rank: number;
  text: string;
  cueCount: number;
  endMs: number;
}

const MAX_SOURCE_CANDIDATES = 5;

/**
 * Completeness-aware source pick. The top-ranked English file can be a
 * partial stub (Breaking Bad S01E01's best pick is 51 cues ending ~2:39),
 * so the top few candidates are downloaded — in parallel — and the one
 * covering the most runtime wins (tie-break: cue count). Null when there
 * are no English candidates; throws when every download fails.
 */
export async function selectEnglishSource(
  osJson: { subtitles?: OsEntry[] },
  id: string,
): Promise<SourceCandidate | null> {
  const ranked = rankEnglish(osJson).slice(0, MAX_SOURCE_CANDIDATES);
  if (!ranked.length) return null;
  const results = await Promise.all(ranked.map(async (entry, i): Promise<SourceCandidate | null> => {
    const label = `[en2ko] ${id}: source candidate ${i + 1}/${ranked.length} (g=${entry.g ?? "?"})`;
    try {
      const res = await downloadText(entry.url!, { timeoutMs: 20000 });
      if (res.status !== 200 || !res.text.includes("-->")) {
        console.warn(`${label}: download failed (HTTP ${res.status}) — skipped`);
        return null;
      }
      const blocks = parseSrt(res.text);
      if (!blocks.length) return null;
      const endMs = cueEndMs(blocks[blocks.length - 1].time) ?? 0;
      return { entry, rank: i + 1, text: res.text, cueCount: blocks.length, endMs };
    } catch (err) {
      console.warn(`${label}: download error (${(err as Error).message}) — skipped`);
      return null;
    }
  }));
  const evaluated = results.filter((r): r is SourceCandidate => r !== null);
  if (!evaluated.length) throw new Error(`all ${ranked.length} English source candidate downloads failed`);
  // Stable sort over rank order keeps the old tie-break exactly.
  evaluated.sort((a, b) => (b.endMs - a.endMs) || (b.cueCount - a.cueCount));
  const w = evaluated[0];
  console.log(`[en2ko] ${id}: selected candidate ${w.rank}/${ranked.length}: ${w.cueCount} cues, ends ${formatMs(w.endMs)}`);
  return w;
}

const translating = new Map<string, Promise<string>>();
const noEnglish = new Map<string, number>(); // "type:id" -> checked-at

/**
 * Title -> translated SRT hash, translating on first use. Null when no
 * English track exists (remembered 6h); throws on backend failure.
 */
async function resolveHash(type: string, id: string): Promise<string | null> {
  const key = `${type}:${id}`;
  const known = await rawGet(["idx", key]);
  if (typeof known === "string" && (await rawGet(["srt", known, "n"])) !== null) return known;
  const miss = noEnglish.get(key);
  if (miss && Date.now() - miss < 6 * HOUR) return null;

  const list = await downloadText(`${OS_V3}/subtitles/${type}/${id}.json`, { timeoutMs: 15000 });
  if (list.status !== 200) throw new Error(`OpenSubtitles v3 HTTP ${list.status}`);
  const picked = await selectEnglishSource(JSON.parse(list.text), id);
  if (!picked) {
    noEnglish.set(key, Date.now());
    return null;
  }
  const enSrt = picked.text;
  const hash = await sha256(enSrt);
  await rawSet(["idx", key], hash);
  if ((await rawGet(["srt", hash, "n"])) !== null) return hash;

  let work = translating.get(hash);
  if (!work) {
    work = (async () => {
      const t0 = Date.now();
      const koSrt = await translateSrt(enSrt, {
        onProgress: (d, t) => console.log(`[en2ko] ${id}: translated ${d}/${t} lines`),
      });
      await setCachedText("src", hash, enSrt);
      await setCachedText("srt", hash, koSrt);
      console.log(`[en2ko] ${id}: cold translation done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return koSrt;
    })();
    translating.set(hash, work);
    const cleanup = () => translating.delete(hash);
    work.then(cleanup, cleanup);
  }
  await work;
  return hash;
}

function subsResponse(base: string, hash: string) {
  return { subtitles: [{ id: `en2ko-${hash.slice(0, 16)}`, url: `${base}/s/${hash}.srt`, lang: "kor" }] };
}

const SUBS_MANIFEST = {
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

// ===========================================================================
// 5. AIO config + shared helpers
// ===========================================================================

interface AioCfg {
  t?: string; // Torrentio base
  m?: string; // MediaFusion base
  s?: string; // StremThru store base (TorBox)
}

function decodeCfg(seg: string): AioCfg | null {
  try {
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    const obj = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    const clean = (v: unknown) => typeof v === "string" ? v.replace(/\/+$/, "") : undefined;
    const cfg: AioCfg = { t: clean(obj.t), m: clean(obj.m), s: clean(obj.s) };
    return cfg.t || cfg.m || cfg.s ? cfg : null;
  } catch {
    return null;
  }
}

/** Catalog "extra" segment ("search=foo&skip=100") -> decoded map. */
function parseExtra(rawSeg: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of rawSeg.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq);
    let v = part.slice(eq + 1);
    try {
      v = decodeURIComponent(v);
    } catch { /* keep raw */ }
    out[k] = v.trim();
  }
  return out;
}

/** Re-encode an extra map for proxying to an upstream addon. */
function extraPath(extra: Record<string, string>): string {
  const s = Object.entries(extra)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return s ? `/${s}` : "";
}

/** Loose key for search: case/space/dot/dash-insensitive. */
const searchNorm = (s: string) => s.toLowerCase().replace(/[\s._\-·+]+/g, "");
const matchesSearch = (name: unknown, q: string) => searchNorm(String(name || "")).includes(searchNorm(q));

/** Strip " (720p)" / "[Not 24/7]" style playlist tags. */
const stripTags = (name: string) => name.replace(/\s*\([^)]*\)/g, "").replace(/\s*\[[^\]]*\]/g, "").trim();

function baseUrl(req: Request): string {
  return (env("BASE_URL") || new URL(req.url).origin).replace(/\/$/, "");
}

// ===========================================================================
// 6. Live TV (iptv-org USA + Korea playlists)
// ===========================================================================

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

interface TvIndex {
  byId: Map<string, TvChan>;
  byCountry: Map<string, TvChan[]>;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "channel";
}

function parseM3u(text: string, country: string, out: TvChan[]): void {
  let pending: Partial<TvChan> | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF")) {
      const attrs: Record<string, string> = {};
      for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
      const name = line.includes(",") ? line.slice(line.lastIndexOf(",") + 1).trim() : "Channel";
      // Tags are ";"-separated; block if ANY tag is blocked.
      const tags = (attrs["group-title"] || "").split(";").map((t) => t.trim().toLowerCase());
      if (tags.some((t) => TV_BLOCKED_TAGS.includes(t)) || TV_BLOCKED_NAMES.includes(stripTags(name))) {
        pending = null;
        continue;
      }
      let group = (attrs["group-title"] || "").split(";")[0].trim();
      if (!group || group === "Undefined") group = "General";
      pending = { name, logo: attrs["tvg-logo"] || "", category: group, country, referer: "", agent: "" };
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

/** Assign stable ids, add the resolver-backed extras, index by id/country. */
function buildTvIndex(parsed: TvChan[]): TvIndex {
  const seen = new Map<string, number>();
  const byId = new Map<string, TvChan>();
  const byCountry = new Map<string, TvChan[]>();
  const add = (ch: TvChan) => {
    let cid = "ftv_" + slug(ch.name);
    const n = (seen.get(cid) || 0) + 1;
    seen.set(cid, n);
    if (n > 1) cid = `${cid}_${n}`;
    const c = { ...ch, id: cid };
    byId.set(cid, c);
    const arr = byCountry.get(c.country) || [];
    arr.push(c);
    byCountry.set(c.country, arr);
  };
  parsed.forEach(add);
  for (const ex of EXTRA_CHANNELS) {
    if (parsed.some((c) => slug(c.name) === slug(ex.name))) continue; // iptv-org has it now
    add({ id: "", name: ex.name, logo: ex.logo, category: ex.category, country: "Korea", url: ex.url, referer: "", agent: "" });
  }
  return { byId, byCountry };
}

let tvIndex: { src: TvChan[]; idx: TvIndex } | null = null;

/** Channel index. 6h fresh, then served stale for up to a week while it
 *  refreshes in the background — no user ever waits on the playlists
 *  once they've loaded once. */
async function liveTv(): Promise<TvIndex> {
  const chans = await cached<TvChan[]>("tv:v3", { ttl: 6 * HOUR, stale: 7 * DAY, negTtl: 5 * MIN, persist: true }, async () => {
    const lists = await Promise.all(IPTV_SOURCES.map(async ([country, url]) => {
      try {
        const r = await downloadText(url, { timeoutMs: 30000 });
        if (r.status !== 200) return null;
        const out: TvChan[] = [];
        parseM3u(r.text, country, out);
        return out;
      } catch {
        return null;
      }
    }));
    if (lists.some((l) => l === null)) {
      // One playlist failed: don't overwrite a full cached list with half.
      if (tvIndex?.src.length) return null;
    }
    const all = lists.flatMap((l) => l || []);
    return all.length ? all : null;
  });
  const src = chans || [];
  if (!tvIndex || tvIndex.src !== src) tvIndex = { src, idx: buildTvIndex(src) };
  return tvIndex.idx;
}

function tvMeta(ch: TvChan, type = "channel"): Json {
  const flags: string[] = [];
  const qm = ch.name.match(/\((\d+p)\)/);
  if (qm) flags.push(qm[1]);
  if (ch.name.includes("[Not 24/7]")) flags.push("Not 24/7");
  if (ch.name.includes("[Geo-blocked]")) flags.push("Geo-blocked");
  if (ch.url.startsWith("resolver:")) flags.push("Official stream — needs a Korea IP to play");
  const meta: Json = {
    id: ch.id,
    type,
    name: stripTags(ch.name),
    genres: [ch.category],
    posterShape: "landscape", // logos are wide; portrait cards crop them
    description: [ch.category, ...flags].join(" • "),
  };
  if (ch.logo) meta.poster = ch.logo;
  return meta;
}

function tvStream(ch: TvChan, req: Request): Json {
  if (ch.url.startsWith("resolver:")) {
    return { url: `${baseUrl(req)}/aio/live/${ch.url.slice("resolver:".length)}`, title: ch.name };
  }
  const stream: Json = { url: ch.url, title: ch.name };
  const h: Record<string, string> = {};
  if (ch.referer) h["Referer"] = ch.referer;
  if (ch.agent) h["User-Agent"] = ch.agent;
  if (Object.keys(h).length) stream.behaviorHints = { proxyHeaders: { request: h } };
  return stream;
}

/** /aio/live/<key>: 302 to a freshly resolved official stream.
 *  KBS Joy: KBS's on-air API (signed CloudFront URL, plays from the US).
 *  MBC Every1: MBC's media API, geo-blocked outside Korea by MBC. */
async function liveResolve(key: string): Promise<Response> {
  let target: string | null = null;
  try {
    if (key === "kbsjoy") {
      const j = await fetchJson("https://mn.kbs.co.kr/api/getNewsLiveStreamUrl?channel=kbsnjoy", 15000);
      target = ((j?.data as Json | undefined)?.streamUrl as string) || null;
    } else if (key === "mbcevery1") {
      const r = await downloadText(
        `https://mediaapi.imbc.com/Player/OnAirPlusURLUtil?ch=2&type=PC&t=${Date.now()}`,
        { timeoutMs: 15000, headers: { Referer: "https://onair.imbc.com/" } },
      );
      if (r.status === 200) target = (JSON.parse(r.text) as { MediaInfo?: { MediaURL?: string } }).MediaInfo?.MediaURL || null;
    } else {
      return new Response("not found", { status: 404 });
    }
  } catch { /* fall through */ }
  if (!target) return new Response("stream unavailable", { status: 502, headers: { "Content-Type": "text/plain" } });
  return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
}

// ===========================================================================
// 7. TorBox store (via StremThru) + Korean episode inventory
// ===========================================================================

interface StoreItem {
  id: string;
  name: string;
}

interface KrEp {
  itemId: string;
  tid: string;
  name: string;
}

/** Whole TorBox library listing. 10 min fresh, stale for a day. While
 *  TorBox refuses (plan restriction since 2026-11-16) the failure is
 *  remembered for 5 min so it can't slow down every episode request. */
function storeItems(sBase: string): Promise<StoreItem[] | null> {
  return cached<StoreItem[]>(`store:${sBase}`, { ttl: 10 * MIN, stale: DAY, negTtl: 5 * MIN, persist: true }, async () => {
    const items: StoreItem[] = [];
    for (let skip = 0; skip <= 400; skip += 100) {
      const page = await fetchJson(`${sBase}/catalog/other/st:store:tb${skip ? `/skip=${skip}` : ""}.json`, 12000);
      if (!page) {
        if (skip === 0) return null;
        break;
      }
      const metas = listOf(page.metas);
      for (const mt of metas) if (mt?.id && mt?.name) items.push({ id: String(mt.id), name: String(mt.name) });
      if (metas.length < 100) break;
    }
    return items.length ? items : null;
  });
}

const krNorm = (s: string) => s.replace(/[\s.\-_·,]+/g, "").toLowerCase();

function krTitleMatches(title: string, show: KrShow): boolean {
  const nt = krNorm(title);
  return nt.includes(krNorm(show.query)) && !(show.exclude || []).some((ex) => nt.includes(krNorm(ex)));
}

let krInvMemo: { items: StoreItem[]; inv: Map<string, KrEp> } | null = null;

/** `${tt}:${episode}` -> the TorBox item holding that episode. */
async function krInventory(sBase: string): Promise<Map<string, KrEp>> {
  const items = await storeItems(sBase);
  if (!items) return new Map();
  if (krInvMemo?.items === items) return krInvMemo.inv;
  const inv = new Map<string, KrEp>();
  for (const it of items) {
    const show = KR_SHOWS.find((s) => krTitleMatches(it.name, s));
    if (!show) continue;
    const m = it.name.match(/[.\s]E(\d{2,4})[.\s]/);
    const ep = m ? parseInt(m[1], 10) : null;
    if (ep && show.imdb) inv.set(`${show.imdb}:${ep}`, { itemId: it.id, tid: it.id.split(":").pop() || it.id, name: it.name });
  }
  krInvMemo = { items, inv };
  return inv;
}

/** Playable URL for a store item via the store's meta -> stream chain. */
async function storeItemUrl(sBase: string, item: KrEp): Promise<string | null> {
  const known = await rawGet(["aio-store-url", item.tid]);
  if (typeof known === "string" && known) return known;
  const meta = await fetchJson(`${sBase}/meta/other/${item.itemId}.json`, 12000);
  const vid = listOf((meta?.meta as Json | undefined)?.videos)[0]?.id;
  if (!vid) return null;
  const s = await fetchJson(`${sBase}/stream/other/${vid}.json`, 12000);
  const url = listOf(s?.streams)[0]?.url;
  if (typeof url !== "string" || !url) return null;
  await rawSet(["aio-store-url", item.tid], url);
  return url;
}

/** TorBox KR stream for an IMDb episode id, if the library has it. */
async function krStreams(sBase: string | undefined, type: string, id: string): Promise<Json[]> {
  if (!sBase || type !== "series") return [];
  const parts = id.split(":");
  if (parts.length !== 3 || !KR_IMDB_IDS.has(parts[0])) return [];
  try {
    const item = (await krInventory(sBase)).get(`${parts[0]}:${Number(parts[2])}`);
    if (!item) return [];
    const u = await storeItemUrl(sBase, item);
    return u ? [{ name: "⚡ TorBox KR", title: item.name, url: u }] : [];
  } catch {
    return [];
  }
}

/** Add library episodes Cinemeta doesn't know yet to a KR show's meta. */
async function injectKrEpisodes(sBase: string, id: string, meta: Json): Promise<Json> {
  try {
    const inv = await krInventory(sBase);
    const videos = [...listOf(meta.videos)];
    const have = new Set(videos.map((v) => v.episode).filter((e) => typeof e === "number"));
    let added = false;
    for (const [key, item] of inv) {
      const [tt, epStr] = key.split(":");
      const ep = Number(epStr);
      if (tt !== id || have.has(ep)) continue;
      const video: Json = { id: `${id}:1:${ep}`, season: 1, episode: ep, title: `Episode ${ep}`, overview: "" };
      const dm = item.name.match(/\.(\d{2})(\d{2})(\d{2})\./);
      if (dm) video.released = `20${dm[1]}-${dm[2]}-${dm[3]}T00:00:00.000Z`;
      videos.push(video);
      added = true;
    }
    if (!added) return meta;
    videos.sort((a, b) =>
      Number(a.season || 0) - Number(b.season || 0) || Number(a.episode || 0) - Number(b.episode || 0)
    );
    return { ...meta, videos };
  } catch {
    return meta; // best-effort; Cinemeta alone is still correct
  }
}

/** Streams for a StremThru library id (st:store:tb:...). */
async function storeStreams(sBase: string, type: string, rawId: string): Promise<Json> {
  // Clients ask for a library video as <itemId>:<season>:<episode>; the
  // store only knows the bare item id, and store items are always "other".
  let lookupId = rawId;
  let lookupType = type;
  if (/^st:store:tb:\d+:\d+:\d+$/.test(rawId)) {
    lookupId = rawId.replace(/:\d+:\d+$/, "");
    lookupType = "other";
  } else if (rawId.startsWith("st:store:tb:")) {
    lookupType = "other";
  }
  const direct = await fetchJson(`${sBase}/stream/${lookupType}/${lookupId}.json`, 12000);
  if (direct && listOf(direct.streams).length) return direct;

  // Item-level ids return zero streams: resolve via the item's videos.
  const viaMeta = async (mid: string, mtype: string) => {
    const m = await fetchJson(`${sBase}/meta/${mtype}/${mid}.json`, 12000);
    const vids = listOf((m?.meta as Json | undefined)?.videos)
      .map((v) => v?.id).filter((v): v is string => typeof v === "string" && !!v);
    const per = await mapLimit(vids, 4, (vid) => fetchJson(`${sBase}/stream/other/${vid}.json`, 12000));
    return per.flatMap((s) => listOf(s?.streams));
  };
  let out = await viaMeta(lookupId, lookupType);
  if (!out.length && rawId.startsWith("st:store:tb:")) {
    // Mangled id (client decoded %2F, double-encoding…): use the torrent id.
    const tid = rawId.split(":")[3];
    const bare = tid && /^\d+$/.test(tid) ? `st:store:tb:${tid}` : "";
    if (bare && bare !== lookupId) out = await viaMeta(bare, "other");
  }
  if (out.length) return { streams: out };
  return direct || { streams: [] };
}

// ===========================================================================
// 8. NBA bridge (CNCVerse)
// ===========================================================================

let bridgeBaseIdx = 0; // sticky: index of the last base that answered

/** GET a bridge path, trying the local bases first (same VM — no TLS, no
 *  round trip out to the public IP). Internal URLs in the reply are
 *  rewritten to the public base. A timeout is final (no second wait). */
async function bridgeJson(path: string, timeoutMs: number): Promise<Json | null> {
  const order = [...BRIDGE_FETCH_BASES.slice(bridgeBaseIdx), ...BRIDGE_FETCH_BASES.slice(0, bridgeBaseIdx)];
  for (const base of order) {
    try {
      const r = await downloadText(base + path, { timeoutMs, headers: { Accept: "application/json" } });
      bridgeBaseIdx = BRIDGE_FETCH_BASES.indexOf(base);
      if (r.status !== 200) return null;
      let text = r.text;
      for (const b of [BRIDGE_INTERNAL, ...BRIDGE_FETCH_BASES]) {
        if (b !== BRIDGE_PUBLIC && b.startsWith("http://")) text = text.split(b).join(BRIDGE_PUBLIC);
      }
      return JSON.parse(text);
    } catch (err) {
      if (err instanceof TimeoutError) return null;
      // connection refused / DNS: try the next base
    }
  }
  return null;
}

/** Bridge catalog: 2 min fresh, then served stale for an hour while it
 *  refreshes — a slow bridge never shows an empty game list. */
function bridgeCatalog(id: string, extra: Record<string, string>): Promise<Json | null> {
  const ep = extraPath(extra);
  return cached<Json>(`cnc-cat:${id}${ep}`, { ttl: 2 * MIN, stale: HOUR, negTtl: 20_000, persist: !ep }, () =>
    bridgeJson(`/catalog/other/${id}${ep}.json`, 30000));
}

/** Bridge streams: 5 min fresh. Older copies (≤30 min) are used only if a
 *  refresh can't finish in 12s; a cold fetch can take ~35s upstream, which
 *  is what the warmer below is for. Empty results aren't cached long. */
function bridgeStreams(type: string, id: string, rawId: string): Promise<Json | null> {
  // Keyed by the DECODED id: clients differ in how they encode it, and the
  // warmer must hit the same entry the client will.
  return cached<Json>(`cnc-stream:${type}:${id}`, { ttl: 5 * MIN, stale: 25 * MIN, wait: 12000, negTtl: 30_000, persist: true }, async () => {
    const j = await bridgeJson(`/stream/${type}/${rawId}.json`, 50000);
    return j && listOf(j.streams).length ? j : null;
  });
}

// ===========================================================================
// 9. AIO manifest / catalog / meta / stream / subtitles
// ===========================================================================

const searchExtra = { name: "search", isRequired: false };
const skipExtra = { name: "skip", isRequired: false };
const genreExtra = (options: string[]) => ({ name: "genre", options, isRequired: false });

const STATIC_CATALOGS: Json[] = [
  { type: "channel", id: "aio_korea_top", name: "Korea — Top", extra: [searchExtra] },
  { type: "channel", id: "aio_usa_all", name: "USA — All", extra: [searchExtra, genreExtra(USA_GENRES)] },
  { type: "channel", id: "aio_korea_all", name: "Korea — All", extra: [searchExtra, genreExtra(KOREA_GENRES)] },
  { type: "other", id: "aio_torbox", name: "TorBox Library", extra: [searchExtra, skipExtra] },
  { type: "series", id: "aio_kr_shows", name: "TorBox KR", extra: [searchExtra] },
  ...CINE_CATS.map((c) => ({
    type: c.type,
    id: c.id,
    name: c.name,
    extra: [searchExtra, genreExtra(c.type === "movie" ? MOVIE_GENRES : SERIES_GENRES), skipExtra],
  })),
  ...SVC_CATS.flatMap(([code, name]) => [
    { type: "movie", id: `aio_svc_${code}_movie`, name },
    { type: "series", id: `aio_svc_${code}_series`, name },
  ]),
  ...BRIDGE_CATS.map((b) => ({ type: "other", id: b.id, name: b.name, extra: [searchExtra, skipExtra] })),
];

/** MediaFusion's catalogs (watchlists), merged into our manifest. Never
 *  holds the manifest more than 6s on a cold start; refreshes hourly in
 *  the background after that. */
async function mfCatalogs(mBase?: string): Promise<Json[]> {
  if (!mBase) return [];
  const cats = await cached<Json[]>(`mf-cats:${mBase}`, { ttl: HOUR, stale: 7 * DAY, coldWait: 6000, negTtl: 10 * MIN, persist: true }, async () => {
    const man = await fetchJson(`${mBase}/manifest.json`, 60000);
    return man ? listOf(man.catalogs) : null;
  });
  return cats || [];
}

async function aioManifest(cfg: AioCfg): Promise<Json> {
  return {
    id: "community.yeonpil.aio",
    version: "1.0.0",
    name: "yeonpil All-in-One",
    description:
      "Torrentio + MediaFusion + TorBox KR episodes + TorBox library + Live TV (USA/Korea) + Cinemeta + Streaming service rows + NBA live (CNCVerse Bridge) + EN→KO subtitles, in one addon.",
    resources: ["catalog", "meta", "stream", "subtitles"],
    types: ["movie", "series", "tv", "channel", "other"],
    idPrefixes: ["tt", "ftv_", "st:", "tbkr", "cnc:"],
    catalogs: [...STATIC_CATALOGS, ...(await mfCatalogs(cfg.m))],
    behaviorHints: { configurable: false },
  };
}

/** Proxy a public catalog through the cache (SWR, keyed by full URL). */
function proxiedCatalog(url: string, ttl: number): Promise<Json | null> {
  return cached<Json>(`cat:${url}`, { ttl, stale: DAY, negTtl: MIN }, () => fetchJson(url, 20000));
}

function krShowsCatalog(): Promise<Json[] | null> {
  return cached<Json[]>("tbkr-cat", { ttl: 15 * MIN, stale: DAY, negTtl: MIN, persist: true }, async () => {
    const j = await fetchJson(`${TBKR_SURGE}/catalog/series/tbkr.json`, 15000);
    return j ? listOf(j.metas) : null;
  });
}

async function aioCatalog(cfg: AioCfg, type: string, id: string, extra: Record<string, string>): Promise<Json> {
  const q = extra.search || "";

  // Live TV rows
  if ((type === "tv" || type === "channel") && ["aio_usa_all", "aio_korea_all", "aio_korea_top"].includes(id)) {
    const tv = await liveTv();
    let chans: TvChan[];
    if (id === "aio_korea_top") {
      const rank = (c: TvChan) => KOREA_TOP.indexOf(stripTags(c.name));
      chans = (tv.byCountry.get("Korea") || []).filter((c) => rank(c) >= 0).sort((a, b) => rank(a) - rank(b));
    } else {
      chans = tv.byCountry.get(id === "aio_usa_all" ? "USA" : "Korea") || [];
    }
    if (extra.genre) chans = chans.filter((c) => c.category === extra.genre);
    // Clients send searches to every searchable catalog: filter, don't dump.
    if (q) chans = chans.filter((c) => matchesSearch(c.name, q));
    return { metas: chans.map((c) => tvMeta(c, type)) };
  }

  // TorBox library
  if (type === "other" && id === "aio_torbox" && cfg.s) {
    let items = (await storeItems(cfg.s)) || [];
    if (q) items = items.filter((it) => matchesSearch(it.name, q));
    const skip = Number(extra.skip) || 0;
    return { metas: items.slice(skip, skip + 100).map((it) => ({ id: it.id, type: "other", name: it.name, posterShape: "poster" })) };
  }

  // TorBox KR shows (static bridge catalog)
  if (type === "series" && id === "aio_kr_shows") {
    let metas = (await krShowsCatalog()) || [];
    if (q) metas = metas.filter((m) => matchesSearch(m.name, q));
    return { metas };
  }

  // NBA bridge rows
  if (type === "other" && id.startsWith("cnc_")) {
    return (await bridgeCatalog(id, extra)) || { metas: [] };
  }

  // Cinemeta rows
  const cine = CINE_CATS.find((c) => c.id === id);
  if (cine && (type === "movie" || type === "series")) {
    const j = await proxiedCatalog(`${CINEMETA}/catalog/${type}/${cine.upstream}${extraPath(extra)}.json`, q ? 10 * MIN : 30 * MIN);
    if (j) return j;
  }

  // Streaming-service rows
  const svc = id.match(/^aio_svc_([a-z]+)_(movie|series)$/);
  if (svc && SVC_CATS.some(([c]) => c === svc[1]) && (type === "movie" || type === "series")) {
    const j = await proxiedCatalog(`${SVC_CATALOGS}/catalog/${type}/${svc[1]}.json`, 3 * HOUR);
    if (j) return j;
  }

  // MediaFusion watchlists
  if (cfg.m && (await mfCatalogs(cfg.m)).some((c) => c.id === id && c.type === type)) {
    const j = await proxiedCatalog(`${cfg.m}/catalog/${type}/${id}${extraPath(extra)}.json`, 5 * MIN);
    if (j) return j;
  }
  return { metas: [] };
}

function cinemetaMeta(type: string, id: string): Promise<Json | null> {
  return cached<Json>(`cm-meta:${type}:${id}`, { ttl: 6 * HOUR, stale: 3 * DAY, wait: 4000, negTtl: 5 * MIN }, async () => {
    const j = await fetchJson(`${CINEMETA}/meta/${type}/${id}.json`, 12000);
    const m = j?.meta as Json | undefined;
    return m && Object.keys(m).length ? m : null;
  });
}

async function aioMeta(cfg: AioCfg, type: string, id: string, rawId: string): Promise<Json> {
  if (type === "tv" || type === "channel") {
    const ch = (await liveTv()).byId.get(id);
    if (!ch) return { meta: {} };
    const src = ch.url.startsWith("resolver:") ? "official stream" : "iptv-org";
    return { meta: { ...tvMeta(ch, type), description: `Live channel · ${src} (${ch.country} · ${ch.category})` } };
  }
  // Bridge and store ids are forwarded still-encoded (rawId): both 404 on
  // the decoded form (base64 padding, colons, literal %2F).
  if (id.startsWith("cnc:")) {
    return (await cached<Json>(`cnc-meta:${type}:${id}`, { ttl: 10 * MIN, stale: DAY, wait: 5000, negTtl: 30_000 }, () =>
      bridgeJson(`/meta/${type}/${rawId}.json`, 15000))) || { meta: {} };
  }
  if (type === "other" || id.startsWith("st:")) {
    if (!cfg.s) return { meta: {} };
    const url = `${cfg.s}/meta/${type}/${rawId}.json`;
    return (await cached<Json>(`st-meta:${url}`, { ttl: 30 * MIN, stale: DAY, wait: 5000, negTtl: MIN }, () => fetchJson(url, 12000))) ||
      { meta: {} };
  }
  if (type === "series" && id.startsWith("tbkr-")) {
    return (await fetchJson(`${TBKR_SURGE}/meta/series/${id}.json`, 15000)) || { meta: {} };
  }
  const meta = await cinemetaMeta(type, id);
  if (!meta) return { meta: {} };
  if (type === "series" && cfg.s && KR_IMDB_IDS.has(id)) return { meta: await injectKrEpisodes(cfg.s, id, meta) };
  return { meta };
}

/** Torrentio / MediaFusion streams for an IMDb id. Cached 30 min; an
 *  older copy (≤6h) is used only when the upstream fails or is slow. */
function upstreamStreams(base: string | undefined, type: string, id: string): Promise<Json[]> {
  if (!base) return Promise.resolve([]);
  return cached<Json[]>(`streams:${base}:${type}:${id}`, { ttl: 30 * MIN, stale: 6 * HOUR, wait: 9000, coldWait: 10000, negTtl: 20_000 }, async () => {
    const j = await fetchJson(`${base}/stream/${type}/${id}.json`, 10000);
    const s = j ? listOf(j.streams) : [];
    return s.length ? s : null;
  }).then((s) => s || []);
}

async function aioStream(cfg: AioCfg, type: string, id: string, rawId: string, req: Request): Promise<Json> {
  if (type === "tv" || type === "channel") {
    const ch = (await liveTv()).byId.get(id);
    return { streams: ch ? [tvStream(ch, req)] : [] };
  }
  if (id.startsWith("cnc:")) {
    return (await bridgeStreams(type, id, rawId)) || { streams: [] };
  }
  if (type === "other" || id.startsWith("st:")) {
    if (!cfg.s) return { streams: [] };
    // Download links are short-lived: 10 min, no stale serving.
    return (await cached<Json>(`st-stream:${cfg.s}:${type}:${rawId}`, { ttl: 10 * MIN, negTtl: 30_000 }, async () => {
      const r = await storeStreams(cfg.s!, type, rawId);
      return listOf(r.streams).length ? r : null;
    })) || { streams: [] };
  }
  // IMDb ids: TorBox KR, Torrentio, MediaFusion — in parallel, merged in
  // that order, deduped.
  const [kr, tor, mf] = await Promise.all([
    krStreams(cfg.s, type, id),
    upstreamStreams(cfg.t, type, id),
    upstreamStreams(cfg.m, type, id),
  ]);
  const seen = new Set<string>();
  const out: Json[] = [];
  for (const s of [...kr, ...tor, ...mf]) {
    const url = typeof s?.url === "string" ? s.url : "";
    if (url.includes("/static/exceptions/")) continue; // upstream error card
    const key = url || `${s?.infoHash || ""}:${s?.fileIdx ?? ""}:${s?.name || ""}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_STREAMS) break;
  }
  return { streams: out };
}

async function aioSubtitles(req: Request, type: string, id: string): Promise<Json> {
  // Only IMDb movies/episodes can have OpenSubtitles tracks.
  if (!id.startsWith("tt") || (type !== "movie" && type !== "series")) return { subtitles: [] };
  try {
    const hash = await resolveHash(type, id);
    return hash ? subsResponse(baseUrl(req), hash) : { subtitles: [] };
  } catch {
    return { subtitles: [] };
  }
}

// ===========================================================================
// 10. Router, TorBox KR bridge host, warmers, startup
// ===========================================================================

function json(code: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "max-age=0",
    },
  });
}

const EMPTY: Record<string, Json> = {
  catalog: { metas: [] },
  meta: { meta: {} },
  subtitles: { subtitles: [] },
  stream: { streams: [] },
};

let lastCfgSeg: string | null = null; // for the warmers

async function handleAio(req: Request, p: string): Promise<Response | null> {
  if (!p.startsWith("/aio/")) return null;
  const seg = p.slice("/aio/".length).split("/").filter(Boolean);
  const cfg = decodeCfg(seg[0] || "");
  if (!cfg) return new Response("not found", { status: 404 });
  if (seg[0] !== lastCfgSeg) {
    lastCfgSeg = seg[0];
    rawSet(["aio-last-cfg"], seg[0]).catch(() => {});
  }
  const resource = seg[1];
  try {
    if (resource === "manifest.json") return json(200, await aioManifest(cfg));
    const type = decodeURIComponent(seg[2] || "");
    let rawId = "";
    let extraRaw = "";
    if (seg.length === 4) {
      rawId = (seg[3] || "").replace(/\.json$/, "");
    } else if (seg.length >= 5) {
      rawId = seg[3] || "";
      extraRaw = (seg[seg.length - 1] || "").replace(/\.json$/, "");
    }
    const id = decodeURIComponent(rawId);
    if (!resource || !type || !id) return json(404, {});
    switch (resource) {
      case "catalog":
        return json(200, await aioCatalog(cfg, type, id, parseExtra(extraRaw)));
      case "meta":
        return json(200, await aioMeta(cfg, type, id, rawId));
      case "stream":
        return json(200, await aioStream(cfg, type, id, rawId, req));
      case "subtitles":
        return json(200, await aioSubtitles(req, type, id));
    }
    return new Response("not found", { status: 404 });
  } catch (err) {
    console.error("[aio] request error:", err);
    return json(200, EMPTY[resource] || EMPTY.stream);
  }
}

/** TorBox KR Bridge on this host (same data as the surge static site, plus
 *  a working search filter). Install: https://<host>/tbkr/manifest.json */
async function handleTbkr(req: Request, p: string): Promise<Response | null> {
  const seg = p.split("/").filter(Boolean);
  if (seg[0] !== "tbkr") return null;
  if (seg[1] === "manifest.json") {
    return json(200, {
      id: "local.tbkr.bridge",
      version: "1.1.0",
      name: "TorBox KR Bridge",
      description: "Your TorBox Korean episodes, attached to their real episode pages.",
      resources: ["stream", "meta", "catalog"],
      types: ["series"],
      idPrefixes: ["tt", "tbkr"],
      catalogs: [{ type: "series", id: "tbkr", name: "TorBox KR", extra: [searchExtra] }],
      behaviorHints: { configurable: false },
    });
  }
  if (seg[1] === "catalog") {
    let metas = (await krShowsCatalog()) || [];
    // Search may come as a path segment (search=<q>.json[&skip=..]) with
    // "+" or "%20" for spaces, or as a query string.
    const pm = p.match(/search=([^/&#?]+)/);
    const rawQ = pm ? pm[1].replace(/\.json$/, "") : new URL(req.url).searchParams.get("search");
    if (rawQ) {
      let q = rawQ.replace(/\+/g, " ");
      try {
        q = decodeURIComponent(q);
      } catch { /* raw */ }
      q = q.toLowerCase();
      metas = metas.filter((m) => String(m.name || "").toLowerCase().includes(q));
    }
    return json(200, { metas });
  }
  if (seg[1] === "meta" || seg[1] === "stream") {
    const empty = seg[1] === "meta" ? { meta: {} } : { streams: [] };
    const id = decodeURIComponent((seg[3] || "").replace(/\.json$/, ""));
    if (!id) return json(200, empty);
    return json(200, (await fetchJson(`${TBKR_SURGE}/${seg[1]}/series/${id}.json`, 15000)) || empty);
  }
  return null;
}

async function handleStandaloneSubs(req: Request, p: string): Promise<Response> {
  const parts = p.slice("/subtitles/".length, -".json".length).split("/").filter(Boolean);
  const type = decodeURIComponent(parts[0] || "");
  const id = decodeURIComponent(parts[1] || "");
  if (!type || !id) return json(200, { subtitles: [] });
  const t0 = Date.now();
  try {
    const hash = await resolveHash(type, id);
    console.log(`[en2ko] /subtitles/${type}/${id} -> ${hash ? "ok" : "no-english-track"} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return json(200, hash ? subsResponse(baseUrl(req), hash) : { subtitles: [] });
  } catch (err) {
    console.error(`[en2ko] /subtitles/${type}/${id} FAILED: ${(err as Error).message}`);
    return json(200, { subtitles: [] });
  }
}

const startedAt = Date.now();
const warmStatus: Record<string, { at: number; ok: number; fail: number; ms: number }> = {};

function health(): Response {
  return json(200, {
    ok: true,
    uptimeMin: Math.round((Date.now() - startedAt) / MIN),
    cacheEntries: mem.size,
    inflight: inflight.size,
    translating: translating.size,
    bridgeBase: BRIDGE_FETCH_BASES[bridgeBaseIdx],
    tvChannels: tvIndex?.idx.byId.size ?? null,
    configSeen: !!lastCfgSeg,
    warmers: Object.fromEntries(
      Object.entries(warmStatus).map(([k, v]) => [k, { ...v, agoSec: Math.round((Date.now() - v.at) / 1000) }]),
    ),
  });
}

export async function handler(req: Request): Promise<Response> {
  const p = new URL(req.url).pathname;
  const t0 = Date.now();
  try {
    if (p === "/aio/live/kbsjoy" || p === "/aio/live/mbcevery1") return await liveResolve(p.slice("/aio/live/".length));
    if (p === "/health") return health();
    if (p.startsWith("/tbkr/")) {
      const r = await handleTbkr(req, p);
      if (r) return r;
    }
    const aio = await handleAio(req, p);
    if (aio) return aio;
    if (p === "/manifest.json") return json(200, SUBS_MANIFEST);
    if (p.startsWith("/subtitles/") && p.endsWith(".json")) return await handleStandaloneSubs(req, p);
    const sMatch = p.match(/^\/s\/([a-f0-9]{64})\.srt$/);
    if (sMatch) {
      const body = await getCachedText("srt", sMatch[1]);
      if (body === null) return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
      });
    }
    return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  } catch (err) {
    console.error("[aio] request error:", err);
    return json(500, { error: String((err as Error).message || err) });
  } finally {
    const ms = Date.now() - t0;
    if (ms > 3000) console.warn(`[aio] slow ${ms}ms ${p.replace(/^\/aio\/[^/]+/, "/aio/<cfg>")}`);
  }
}

// --- Background warmers (long-running VM process only) ---------------------
// Keep the caches users hit most hot so they never pay a cold upstream:
//   every 90s  NBA catalogs (+ streams for the games listed in Live rows)
//   every 30m  live TV playlists, MediaFusion manifest, TorBox library

async function warm(name: string, fn: () => Promise<{ ok: number; fail: number }>) {
  const t0 = Date.now();
  try {
    const r = await fn();
    warmStatus[name] = { at: Date.now(), ...r, ms: Date.now() - t0 };
  } catch (err) {
    warmStatus[name] = { at: Date.now(), ok: 0, fail: 1, ms: Date.now() - t0 };
    console.warn(`[warm] ${name}: ${(err as Error).message}`);
  }
}

const WARM_STREAMS_PER_ROW = 8;

async function warmBridge() {
  let ok = 0;
  let fail = 0;
  const liveIds: [type: string, id: string][] = [];
  await mapLimit(BRIDGE_CATS, 3, async (c) => {
    const cat = await bridgeCatalog(c.id, {});
    if (cat) ok++;
    else fail++;
    if (c.id.includes("LiveEvents")) {
      for (const m of listOf(cat?.metas).slice(0, WARM_STREAMS_PER_ROW)) {
        if (typeof m.id === "string") liveIds.push([typeof m.type === "string" ? m.type : "other", m.id]);
      }
    }
  });
  // Ids from catalogs are decoded; the stream route uses the encoded form.
  await mapLimit(liveIds, 2, async ([type, id]) => {
    const s = await bridgeStreams(type, id, encodeURIComponent(id));
    if (s) ok++;
    else fail++;
  });
  return { ok, fail };
}

async function warmSlow() {
  let ok = 0;
  let fail = 0;
  const tally = (v: unknown) => (v ? ok++ : fail++);
  tally((await liveTv()).byId.size);
  const seg = lastCfgSeg ?? ((await rawGet(["aio-last-cfg"])) as string | null);
  const cfg = seg ? decodeCfg(seg) : null;
  if (cfg) {
    lastCfgSeg ??= seg;
    if (cfg.m) tally((await mfCatalogs(cfg.m)).length);
    if (cfg.s) tally(await storeItems(cfg.s));
  }
  tally(await krShowsCatalog());
  return { ok, fail };
}

if (import.meta.main) {
  const port = env("PORT");
  if (port) Deno.serve({ port: Number(port) }, handler);
  else Deno.serve(handler);

  if (env("AIO_WARM") !== "0") {
    const loop = (name: string, fn: () => Promise<{ ok: number; fail: number }>, everyMs: number) => {
      let running = false;
      const tick = async () => {
        if (running) return;
        running = true;
        await warm(name, fn);
        running = false;
      };
      setTimeout(tick, 2000);
      setInterval(tick, everyMs);
    };
    loop("bridge", warmBridge, 90_000);
    loop("slow", warmSlow, 30 * MIN);
  }
}
