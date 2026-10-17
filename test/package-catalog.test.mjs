import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPackageCatalog,
  MAX_CATALOG_BYTES,
} from "../src/resources/package-catalog.mjs";

const html =
  '<!doctype html><main><form action="/packages"><select name="type"><option value="skill">skill</option></select></form><article data-package-card="true" data-package-name="@fixture/tools" data-package-types="extension skill" data-package-downloads="1456" data-package-date="1790972865883"><p class="packages-desc">Official description</p></article></main>';
const response = (body = html, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

test("catalog requests canonical official defaults without following normalization redirects", async (t) => {
  const catalog = createPackageCatalog({
    fetchPage: async (url, options) => {
      assert.equal(options.redirect, "error");
      if (
        url.searchParams.get("sort") === "downloads" ||
        url.searchParams.get("page") === "1"
      )
        return Response.redirect("https://pi.dev/packages?name=pi-subagents");
      return response();
    },
  });
  t.after(() => catalog.stop());
  const result = await catalog.list({ q: "pi-subagents" });
  assert.equal(result.sourceUrl, "https://pi.dev/packages?name=pi-subagents");
});

test("catalog forwards the official filters/sort/page, retains complete HTML and refreshes cached pages", async (t) => {
  const requests = [];
  let now = 1000;
  const catalog = createPackageCatalog({
    now: () => now,
    fetchPage: async (url, options) => {
      requests.push({ url: String(url), options });
      return response();
    },
  });
  t.after(() => catalog.stop());
  const input = { q: "MCP & tools", type: "skill", sort: "recent", page: 2 };
  const first = await catalog.list(input);
  assert.equal(first.source, "pi.dev");
  assert.equal(first.html, html);
  const url = new URL(requests[0].url);
  assert.equal(url.origin, "https://pi.dev");
  assert.equal(url.pathname, "/packages");
  assert.equal(url.searchParams.get("name"), input.q);
  assert.equal(url.searchParams.get("type"), "skill");
  assert.equal(url.searchParams.get("sort"), "recent");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(requests[0].options.redirect, "error");
  await catalog.list(input);
  assert.equal(requests.length, 1);
  now += 1;
  const fresh = await catalog.list({ ...input, refresh: true });
  assert.equal(requests.length, 2);
  assert.equal(fresh.fetchedAt, now);
  assert.equal(requests[1].options.headers["Cache-Control"], "no-cache");
});

test("catalog details preserve long README and never accept arbitrary origins, paths or unsupported types", async (t) => {
  const urls = [];
  const readme =
    '<main><h1 class="content-title">@fixture/tools</h1><div class="packages-readme"><p>' +
    "Full README ".repeat(6500) +
    "END</p></div></main>";
  const catalog = createPackageCatalog({
    fetchPage: async (url) => {
      urls.push(String(url));
      return response(readme);
    },
  });
  t.after(() => catalog.stop());
  assert.equal((await catalog.details("@fixture/tools")).html, readme);
  assert.equal(new URL(urls[0]).pathname, "/packages/@fixture/tools");
  for (const name of [
    "../settings",
    "https://evil.test",
    "fixture?redirect=evil",
    "fixture#x",
    "fixture@1.0.0",
    "@scope/../x",
  ])
    await assert.rejects(catalog.details(name), { status: 422 });
  for (const value of [
    { type: "mcp" },
    { sort: "stars" },
    { page: -1 },
    { page: 1.5 },
    { q: "x".repeat(121) },
    { refresh: "yes" },
  ])
    await assert.rejects(catalog.list(value), { status: 422 });
  assert.equal(urls.length, 1);
});

test("catalog bounds response bytes, reports missing/failed pages and does not disguise failed refresh as fresh data", async (t) => {
  let mode = "valid";
  const catalog = createPackageCatalog({
    fetchPage: async () =>
      mode === "missing"
        ? response("missing", 404)
        : mode === "failed"
          ? response("failed", 503)
          : mode === "large"
            ? response("x".repeat(MAX_CATALOG_BYTES + 1))
            : mode === "json"
              ? new Response("{}", {
                  headers: { "content-type": "application/json" },
                })
              : response(),
  });
  t.after(() => catalog.stop());
  await catalog.list();
  mode = "failed";
  await assert.rejects(catalog.list({ refresh: true }), { status: 502 });
  mode = "missing";
  await assert.rejects(catalog.details("not-published"), { status: 404 });
  mode = "large";
  await assert.rejects(catalog.details("large"), { status: 413 });
  mode = "json";
  await assert.rejects(catalog.details("json"), { status: 502 });
});

test("catalog coalesces reads and cancels only its own fetches when the transport stops", async () => {
  let started, release;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const catalog = createPackageCatalog({
    fetchPage: async (_url, { signal }) => {
      started();
      return new Promise((resolve, reject) => {
        release = () => resolve(response());
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  const first = catalog.list();
  const second = catalog.list();
  await ready;
  release();
  assert.deepEqual(await first, await second);
  const pending = catalog.details("waiting");
  await ready;
  const rejected = assert.rejects(pending, { status: 502 });
  await catalog.stop();
  await rejected;
});
