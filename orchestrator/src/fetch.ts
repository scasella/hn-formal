import path from "node:path";
import type { DataJson } from "./types.js";
import { fetchFrontPage, fetchOptionsFromEnv, pruneCache } from "./hn.js";
import { fromRepo } from "./paths.js";
import { log, writeJsonAtomic } from "./util.js";

export interface FetchArgs {
  out: string;
  cache?: string;
}

/** Validate the CONTRACT data JSON shape; throws with a reason. */
export function validateData(d: DataJson): void {
  if (!Number.isInteger(d.fetchedAt)) throw new Error("fetchedAt must be an integer");
  if (!Array.isArray(d.top) || d.top.length !== 30) throw new Error(`top must have exactly 30 ids (got ${d.top?.length})`);
  if (!d.items || typeof d.items !== "object") throw new Error("items must be an object");
  for (const id of d.top) {
    const it = d.items[String(id)];
    if (!it) throw new Error(`top id ${id} missing from items`);
  }
  for (const [k, it] of Object.entries(d.items)) {
    if (String(it.id) !== k) throw new Error(`items[${k}].id mismatch`);
    if (!["job", "story", "comment", "poll", "pollopt"].includes(it.type)) throw new Error(`items[${k}].type invalid`);
  }
}

export async function cmdFetch(args: FetchArgs): Promise<DataJson> {
  const opts = fetchOptionsFromEnv(args.cache ? path.resolve(args.cache) : undefined);
  const started = Date.now();
  const { data, stats } = await fetchFrontPage(opts);
  validateData(data);
  const out = path.isAbsolute(args.out) ? args.out : fromRepo(args.out);
  await writeJsonAtomic(out, data);
  const pruned = await pruneCache(opts.cacheDir);
  log(
    `fetch: ${data.top.length} top, ${Object.keys(data.items).length} items, ` +
      `${stats.requests} requests, ${stats.cacheHits} cache hits, ${stats.nullItems} null, ` +
      `${stats.cappedStories} capped, ${pruned} cache files pruned, ${Date.now() - started}ms -> ${out}`,
  );
  return data;
}
