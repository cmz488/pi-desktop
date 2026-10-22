import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest, createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { createDeskBridge } from "../src/server/bridge.mjs";
import { createStaticAssetHandler } from "../src/server/web-assets.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-assets-"));
  await writeFile(join(dir, "settings.json"), "{}");
  const bridge = createDeskBridge({
    port: 0,
    host: "127.0.0.1",
    agentDir: dir,
    snapshot: () => ({
      models: [],
      messages: [
        {
          role: "assistant",
          text: "A long conversation with repeated project context.\n".repeat(
            4000,
          ),
        },
      ],
    }),
  });
  const origin = new URL(await bridge.start()).origin;
  t.after(async () => {
    await bridge.stop();
    await rm(dir, { recursive: true, force: true });
  });
  // Raw HTTP measures transferred bytes; fetch transparently decompresses gzip.
  const request = (path, headers = {}, method = "GET") =>
    new Promise((resolve, reject) => {
      const req = httpRequest(origin + path, { headers, method }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  return { request, origin, bridge };
}
test("host shutdown completes the compressed SSE member before closing its socket", async (t) => {
  const f = await fixture(t);
  const response = await fetch(f.origin + "/api/events");
  assert.equal(response.headers.get("content-encoding"), "gzip");
  const reader = response.body.getReader();
  await reader.read();
  const finished = (async () => {
    while (!(await reader.read()).done) {}
  })();
  // Observe rejection promptly while shutdown proceeds.
  const observed = finished.then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  await f.bridge.stop();
  const outcome = await observed;
  assert(outcome.ok, outcome.error?.message);
});

test("large static modules use gzip and conditional requests avoid repeat downloads", async (t) => {
  const f = await fixture(t);
  const plain = await f.request("/vendor/katex.mjs");
  const compressed = await f.request("/vendor/katex.mjs", {
    "Accept-Encoding": "gzip",
  });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert(compressed.body.length < plain.body.length / 4);
  assert.deepEqual(gunzipSync(compressed.body), plain.body);
  assert.equal(compressed.headers["cache-control"], "no-cache");
  assert.equal(compressed.headers.vary, "Accept-Encoding");
  assert.notEqual(compressed.headers.etag, plain.headers.etag);
  const revalidated = await f.request("/vendor/katex.mjs", {
    "Accept-Encoding": "gzip",
    "If-None-Match": compressed.headers.etag,
  });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.body.length, 0);
  assert.equal(revalidated.headers["content-length"], undefined);
  t.diagnostic(
    `KaTeX transfer: ${plain.body.length} -> ${compressed.body.length} bytes; unchanged reload: 0 body bytes`,
  );
});

test("page scripts and styles reduce cold-transfer bytes", async (t) => {
  const f = await fixture(t);
  const paths = [
    "/",
    "/prototype.js",
    "/prototype.css",
    "/design-tokens.css",
    "/chat-shell.css",
    "/extension-workbench.js",
    "/connection.mjs",
    "/markdown.mjs",
    "/pi-commands.mjs",
    "/vendor/katex.css",
    "/vendor/katex.mjs",
    "/vendor/marked.mjs",
    "/vendor/purify.mjs",
  ];
  let plainBytes = 0,
    compressedBytes = 0;
  for (const path of paths) {
    const plain = await f.request(path);
    const compressed = await f.request(path, { "Accept-Encoding": "gzip" });
    assert.equal(compressed.status, 200);
    assert.deepEqual(gunzipSync(compressed.body), plain.body);
    plainBytes += plain.body.length;
    compressedBytes += compressed.body.length;
  }
  assert(compressedBytes < plainBytes / 3);
  t.diagnostic(
    `Page scripts/styles transfer: ${plainBytes} -> ${compressedBytes} bytes (fonts and session snapshots excluded)`,
  );
});

test("static encoding negotiation respects gzip exclusions and representation validators", async (t) => {
  const f = await fixture(t);
  const plain = await f.request("/prototype.js", {
    "Accept-Encoding": "gzip;q=0, br;q=0, *;q=1",
  });
  assert.equal(plain.headers["content-encoding"], undefined);
  assert(plain.headers.etag);
  for (const encoding of ["gzip;q=0.2, identity;q=1", "gzip;q=invalid", ""]) {
    const result = await f.request("/prototype.js", {
      "Accept-Encoding": encoding,
    });
    assert.equal(result.headers["content-encoding"], undefined);
  }
  const excluded = await f.request("/prototype.js", {
    "Accept-Encoding": "*;q=0",
  });
  assert.equal(excluded.status, 406);
  const wildcardEncoding = await f.request("/prototype.js", {
    "Accept-Encoding": "*",
  });
  assert.equal(wildcardEncoding.headers["content-encoding"], "br");
  const compressed = await f.request("/prototype.js", {
    "Accept-Encoding": "br, gzip",
    "If-None-Match": plain.headers.etag,
  });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers["content-encoding"], "br");
  assert.deepEqual(brotliDecompressSync(compressed.body), plain.body);
  const weak = await f.request("/prototype.js", {
    "If-None-Match": `"other", W/${plain.headers.etag}`,
  });
  assert.equal(weak.status, 304);
  const wildcard = await f.request("/prototype.js", { "If-None-Match": "*" });
  assert.equal(wildcard.status, 304);
});

test("live HTML loads its first-paint bootstrap as a same-origin script", async (t) => {
  // CSP 是 script-src 'self'：内联脚本会被拦截，主题与嵌入布局就会在延迟模块
  // 运行前闪一下。首次绘制引导必须由外部脚本承担。
  const f = await fixture(t);
  const page = await f.request("/");
  const html = page.body.toString();
  assert(html.includes('<script src="boot.js"></script>'));
  assert(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "HTML 不能依赖内联脚本");
  const boot = await f.request("/boot.js");
  assert.equal(boot.status, 200);
  assert.equal(boot.headers["content-type"], "text/javascript; charset=utf-8");
  assert(boot.body.length > 0);
});

test("live HTML and HEAD use the same static representation; fonts stay binary", async (t) => {
  const f = await fixture(t);
  const page = await f.request("/");
  assert(page.body.toString().includes('name="pi-desk-mode" content="live"'));
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  const head = await f.request("/", {}, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers.etag, page.headers.etag);
  assert.equal(Number(head.headers["content-length"]), page.body.length);
  const font = await f.request("/fonts/DepartureMono-Regular.woff2", {
    "Accept-Encoding": "gzip",
  });
  assert.equal(font.headers["content-type"], "font/woff2");
  assert.equal(font.headers["content-encoding"], undefined);
});

test("same-length asset edits invalidate cached bytes and ETags without a server restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-asset-edit-"));
  const file = join(dir, "module.mjs");
  const first = "export default 'before';\n".repeat(100);
  const second = "export default 'after!';\n".repeat(100);
  assert.equal(first.length, second.length);
  await writeFile(file, first);
  const handler = createStaticAssetHandler(
    new Map([["/module.mjs", [pathToFileURL(file).href, "text/javascript"]]]),
  );
  const server = createServer(async (request, response) => {
    try {
      if (
        await handler(
          request,
          response,
          new URL(request.url, "http://localhost").pathname,
        )
      )
        return;
      response.writeHead(404);
      response.end();
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const before = await fetch(origin + "/module.mjs");
  assert.equal(await before.text(), first);
  const etag = before.headers.get("etag");
  await writeFile(file, second);
  const after = await fetch(origin + "/module.mjs", {
    headers: { "If-None-Match": etag },
  });
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.get("etag"), etag);
  assert.equal(await after.text(), second);
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const result = await fetch(origin + "/module.mjs");
      assert.equal(await result.text(), second);
      return result.headers.get("etag");
    }),
  );
  assert(concurrent.every((value) => value === after.headers.get("etag")));
  assert.equal((await fetch(origin + "/not-allowlisted")).status, 404);
  await rm(file);
  assert.equal((await fetch(origin + "/module.mjs")).status, 500);
  await writeFile(file, first);
  assert.equal(await (await fetch(origin + "/module.mjs")).text(), first);
});

test("session APIs use gzip without caching and compressed SSE delivers immediate data", async (t) => {
  const f = await fixture(t);
  const plain = await f.request("/api/state");
  const state = await f.request("/api/state", { "Accept-Encoding": "gzip" });
  assert.equal(state.headers["cache-control"], "no-store");
  assert.equal(state.headers["content-encoding"], "gzip");
  assert.deepEqual(gunzipSync(state.body), plain.body);
  assert(state.body.length < plain.body.length / 10);
  t.diagnostic(
    `Session transfer: ${plain.body.length} -> ${state.body.length} bytes`,
  );
  assert.match(state.headers.etag, /^W\//);
  const unchanged = await f.request("/api/state", {
    "If-None-Match": state.headers.etag,
  });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body.length, 0);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(f.origin + "/api/events", {
    headers: { "Accept-Encoding": "gzip" },
    signal: controller.signal,
  });
  assert.equal(response.headers.get("content-encoding"), "gzip");
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  const chunk = await Promise.race([
    response.body.getReader().read(),
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("compressed SSE buffered its first event")),
        1000,
      );
      timer.unref();
    }),
  ]);
  assert(new TextDecoder().decode(chunk.value).includes(": connected"));
  controller.abort();
});
