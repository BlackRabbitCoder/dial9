import http from "node:http";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [dataDir, backend] = process.argv.slice(2);
if (!dataDir) throw new Error("Usage: node serve-span-explorer.mjs CACHE_DIR [BACKEND_ORIGIN]");
const dist = path.resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".bin": "application/octet-stream", ".svg": "image/svg+xml" };
const cache = path.join(dataDir, "api-cache");
await mkdir(cache, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname.startsWith("/api/") && backend) {
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => key.startsWith("x-dial9-aws-") || key === "content-type").sort(([a], [b]) => a.localeCompare(b)));
      const requestBody = req.method === "GET" || req.method === "HEAD" ? null : Buffer.concat(await Array.fromAsync(req));
      const key = createHash("sha256").update(JSON.stringify([req.method, req.url, headers])).update(requestBody ?? "").digest("hex");
      const saved = path.join(cache, key);
      try {
        const meta = JSON.parse(await readFile(saved + ".json", "utf8"));
        const body = await readFile(saved + ".bin");
        res.writeHead(meta.status, { "content-type": meta.contentType, "cache-control": "no-store" });
        res.end(body);
        return;
      } catch { /* First read: use the backend, then retain the response locally. */ }
      const response = await fetch(new URL(req.url, backend), { method: req.method, headers, body: requestBody });
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      res.writeHead(response.status, { "content-type": contentType, "cache-control": "no-store" });
      const chunks = [];
      for await (const chunk of response.body) { res.write(chunk); chunks.push(Buffer.from(chunk)); }
      res.end();
      if (response.ok) {
        await writeFile(saved + ".bin", Buffer.concat(chunks));
        await writeFile(saved + ".json", JSON.stringify({ status: response.status, contentType }));
      }
      return;
    }
    const file = path.resolve(dist, `.${pathname === "/" ? "/span_explorer.html" : decodeURIComponent(pathname)}`);
    if (!file.startsWith(dist + path.sep)) {
      res.writeHead(403); res.end(); return;
    }
    await stat(file);
    res.writeHead(200, { "content-type": mime[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(await readFile(file));
  } catch (error) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(String(error));
  }
});
server.listen(Number(process.env.DIAL9_SPAN_DEMO_PORT ?? 0), "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}/span_explorer.html`));
