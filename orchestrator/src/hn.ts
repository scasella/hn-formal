import fsp from "node:fs/promises";
import path from "node:path";
import type { DataJson, HnItem } from "./types.js";
import { cacheDir } from "./paths.js";
import { ensureDir, envInt, limiter, log, nowSec, readJsonOr, sleep, writeJsonAtomic } from "./util.js";

export const HN_BASE = "https://hacker-news.firebaseio.com/v0";
const TYPES = new Set(["job", "story", "comment", "poll", "pollopt"]);

export interface FetchOptions {
  cacheDir: string;
  topN: number;
  maxCommentsPerStory: number;
  maxDepth: number;
  itemTtlSeconds: number;
  /** TTL for comments 1-7 days old (replies still arrive; bounded lag). */
  agedItemTtlSeconds: number;
  /** TTL for comments older than 7 days. */
  oldItemTtlSeconds: number;
  concurrency: number;
}

export function fetchOptionsFromEnv(cache?: string): FetchOptions {
  return {
    cacheDir: cache ?? path.join(cacheDir(), "items"),
    topN: 30,
    maxCommentsPerStory: envInt("MAX_COMMENTS_PER_STORY", 400),
    maxDepth: envInt("MAX_DEPTH", 50),
    itemTtlSeconds: envInt("ITEM_TTL_SECONDS", 900),
    agedItemTtlSeconds: envInt("AGED_ITEM_TTL_SECONDS", 4 * 3600),
    oldItemTtlSeconds: envInt("OLD_ITEM_TTL_SECONDS", 86_400),
    concurrency: envInt("FETCH_CONCURRENCY", 16),
  };
}

/**
 * Cache TTL for a non-top item. Comments keep receiving replies for a day
 * or two (the baseline check of 2026-10-10 found eight live replies hidden
 * by a 24h TTL on day-old comments), so: under 24h old, the short TTL;
 * 1-7 days, the aged TTL (4h by default); older, the long TTL.
 */
export function commentTtl(it: HnItem, now: number, opts: Pick<FetchOptions, "itemTtlSeconds" | "agedItemTtlSeconds" | "oldItemTtlSeconds">): number {
  if (it.type !== "comment" || typeof it.time !== "number") return opts.itemTtlSeconds;
  const age = now - it.time;
  if (age > 7 * 86_400) return opts.oldItemTtlSeconds;
  if (age > 86_400) return opts.agedItemTtlSeconds;
  return opts.itemTtlSeconds;
}

interface CacheEntry {
  fetchedAt: number;
  item: HnItem | null;
}

export interface FetchStats {
  requests: number;
  cacheHits: number;
  nullItems: number;
  cappedStories: number;
}

async function getJson(url: string, attempts = 4): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} (not retried)`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error).message ?? e);
      if (/not retried/.test(msg)) throw e;
      await sleep(500 * 2 ** i + Math.random() * 250);
    }
  }
  throw lastErr;
}

export class HnClient {
  readonly stats: FetchStats = { requests: 0, cacheHits: 0, nullItems: 0, cappedStories: 0 };
  private readonly run: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly inflight = new Map<number, Promise<HnItem | null>>();

  constructor(readonly opts: FetchOptions) {
    this.run = limiter(opts.concurrency);
  }

  async topStories(): Promise<number[]> {
    this.stats.requests++;
    const ids = (await getJson(`${HN_BASE}/topstories.json`)) as unknown;
    if (!Array.isArray(ids) || !ids.every((x) => Number.isInteger(x))) throw new Error("topstories: unexpected payload");
    return ids as number[];
  }

  private cachePath(id: number): string {
    return path.join(this.opts.cacheDir, `${id}.json`);
  }

  private ttlFor(entry: CacheEntry, now: number, isTop: boolean): number {
    const it = entry.item;
    if (isTop || !it) return this.opts.itemTtlSeconds;
    return commentTtl(it, now, this.opts);
  }

  /** Fetch one item, through the disk cache. Null when the API has no item. */
  item(id: number, isTop = false): Promise<HnItem | null> {
    const existing = this.inflight.get(id);
    if (existing) return existing;
    const p = this.run(async () => {
      const now = nowSec();
      const cached = await readJsonOr<CacheEntry | null>(this.cachePath(id), null);
      if (cached && now - cached.fetchedAt < this.ttlFor(cached, now, isTop)) {
        this.stats.cacheHits++;
        return cached.item;
      }
      this.stats.requests++;
      const raw = (await getJson(`${HN_BASE}/item/${id}.json`)) as HnItem | null;
      let item: HnItem | null = null;
      if (raw && typeof raw === "object" && raw.id === id && typeof raw.type === "string" && TYPES.has(raw.type)) {
        item = raw;
      } else if (raw !== null) {
        log(`item ${id}: unexpected payload, treating as absent`);
      }
      if (!item) this.stats.nullItems++;
      await writeJsonAtomic(this.cachePath(id), { fetchedAt: now, item } satisfies CacheEntry);
      return item;
    }).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  /**
   * Breadth-first walk of `kids` from a top item, capped by count and depth.
   * Returns every reachable item (including the root) that the API returned.
   */
  async tree(rootId: number, into: Map<number, HnItem>): Promise<void> {
    const root = await this.item(rootId, true);
    if (!root) return;
    into.set(root.id, root);
    // Poll options are not comments but must be present for the renderer.
    const seeds: number[] = [...(root.kids ?? []), ...(root.parts ?? [])];
    let frontier: Array<{ id: number; depth: number }> = seeds.map((id) => ({ id, depth: 1 }));
    let count = 0;
    let capped = false;
    const seen = new Set<number>([root.id]);
    while (frontier.length > 0) {
      const batch = frontier.filter((f) => !seen.has(f.id));
      for (const f of batch) seen.add(f.id);
      if (count + batch.length > this.opts.maxCommentsPerStory) {
        capped = true;
        batch.length = Math.max(0, this.opts.maxCommentsPerStory - count);
      }
      const fetched = await Promise.all(batch.map(async (f) => ({ f, item: await this.item(f.id) })));
      count += batch.length;
      const next: Array<{ id: number; depth: number }> = [];
      for (const { f, item } of fetched) {
        if (!item) continue;
        into.set(item.id, item);
        if (f.depth >= this.opts.maxDepth) {
          if (item.kids?.length) capped = true;
          continue;
        }
        for (const k of item.kids ?? []) next.push({ id: k, depth: f.depth + 1 });
      }
      frontier = next;
      if (count >= this.opts.maxCommentsPerStory) {
        if (frontier.length) capped = true;
        break;
      }
    }
    if (capped) this.stats.cappedStories++;
  }
}

/** Produce the CONTRACT data JSON. */
export async function fetchFrontPage(opts: FetchOptions): Promise<{ data: DataJson; stats: FetchStats }> {
  await ensureDir(opts.cacheDir);
  const client = new HnClient(opts);
  const ids = await client.topStories();
  const items = new Map<number, HnItem>();
  const top: number[] = [];
  // Exactly topN ids: if an item is missing from the API, take the next id.
  let cursor = 0;
  while (top.length < opts.topN && cursor < ids.length) {
    const want = opts.topN - top.length;
    const slice = ids.slice(cursor, cursor + want);
    cursor += slice.length;
    const roots = await Promise.all(slice.map((id) => client.item(id, true)));
    for (let i = 0; i < slice.length; i++) if (roots[i]) top.push(slice[i]!);
  }
  if (top.length < opts.topN) log(`warning: only ${top.length} live top items`);
  await Promise.all(top.map((id) => client.tree(id, items)));
  const out: DataJson = { fetchedAt: nowSec(), top, items: {} };
  for (const id of [...items.keys()].sort((a, b) => a - b)) out.items[String(id)] = items.get(id)!;
  return { data: out, stats: client.stats };
}

/** Evict cache files older than `maxAgeSeconds` (keeps the cache dir bounded). */
export async function pruneCache(dir: string, maxAgeSeconds = 7 * 86_400): Promise<number> {
  let removed = 0;
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeSeconds * 1000;
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      const st = await fsp.stat(p);
      if (st.mtimeMs < cutoff) {
        await fsp.unlink(p);
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}
