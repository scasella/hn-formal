import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
};

export interface StaticServer {
  /** Origin, e.g. `http://127.0.0.1:51234` (no prefix). */
  url: string;
  /** The normalized site prefix this server strips (`/hn-formal`, or `""`). */
  prefix: string;
  /** URL of a page as it will be addressed on Pages: `<origin><prefix>/<rel>`. */
  pageUrl(rel: string): string;
  close(): Promise<void>;
}

/**
 * Normalize a site path prefix: leading slash, no trailing slash; `""` or `/`
 * means no prefix. `undefined` selects the default (`/hn-formal`).
 */
export function normalizePrefix(raw: string | undefined, def = "/hn-formal"): string {
  const v = (raw === undefined ? def : raw).trim();
  const stripped = v.replace(/^\/+/, "").replace(/\/+$/, "");
  return stripped === "" ? "" : `/${stripped}`;
}

/**
 * The GitHub Pages path prefix the rendered site lives under
 * (https://scasella.github.io/hn-formal/ -> `/hn-formal`). `SITE_PREFIX` env
 * var; set it to the empty string for a site served at the origin root.
 * Read raw (not via envStr) because the empty string is a meaningful value.
 */
export function sitePrefix(): string {
  return normalizePrefix(process.env.SITE_PREFIX);
}

/**
 * Map a request pathname to a path relative to the site root: a path under the
 * prefix has it stripped (`/hn-formal/style.css` -> `/style.css`, exactly
 * `/hn-formal` -> `/`); any other path is served as-is, so unprefixed links
 * (`/style.css`) keep working too.
 */
/** Strip the site prefix; returns null when a prefix is configured and the
path is outside it (such a page would 404 on Pages, so it 404s here too). */
export function stripPrefix(pathname: string, prefix: string): string | null {
  if (!prefix) return pathname;
  if (pathname === prefix) return "/";
  if (pathname.startsWith(prefix + "/")) return pathname.slice(prefix.length);
  return null;
}

/**
 * Minimal static server so pages can reference root-relative URLs that
 * include the Pages prefix (`/hn-formal/style.css`) and resolve exactly as
 * they will on Pages (file:// would break absolute paths). Binds 127.0.0.1 on
 * a free port.
 */
export async function serveStatic(root: string, prefix: string = sitePrefix()): Promise<StaticServer> {
  const absRoot = path.resolve(root);
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://localhost");
      let rel = stripPrefix(decodeURIComponent(u.pathname), prefix);
      if (rel === null) {
        res.writeHead(404).end();
        return;
      }
      if (rel.endsWith("/")) rel += "index.html";
      const file = path.resolve(absRoot, "." + rel);
      if (!file.startsWith(absRoot + path.sep) && file !== absRoot) {
        res.writeHead(403).end();
        return;
      }
      let st = await fsp.stat(file).catch(() => null);
      let target = file;
      if (st?.isDirectory()) {
        target = path.join(file, "index.html");
        st = await fsp.stat(target).catch(() => null);
      }
      if (!st || !st.isFile()) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream",
        "content-length": st.size,
        "cache-control": "no-store",
      });
      fs.createReadStream(target).pipe(res);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end(String(e));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    prefix,
    pageUrl: (rel) => `${url}${prefix}/${rel.replace(/^\/+/, "")}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
