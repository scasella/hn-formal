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
  url: string;
  close(): Promise<void>;
}

/**
 * Minimal static server so pages can reference `/style.css` from the site
 * root (file:// would break absolute paths). Binds 127.0.0.1 on a free port.
 */
export async function serveStatic(root: string): Promise<StaticServer> {
  const absRoot = path.resolve(root);
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://localhost");
      let rel = decodeURIComponent(u.pathname);
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
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
