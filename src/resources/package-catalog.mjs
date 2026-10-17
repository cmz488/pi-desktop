import { DeskError } from "../config/config-store.mjs";

const CATALOG_ORIGIN = "https://pi.dev";
const CATALOG_TIMEOUT_MS = 12_000;
const CATALOG_CACHE_TTL_MS = 60_000;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 32;
const MAX_CONCURRENT_REQUESTS = 4;
export const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const types = ["extension", "skill", "theme", "prompt"];
const sorts = ["downloads", "recent", "name"];

export function npmPackageName(source) {
  if (typeof source !== "string") return null;
  const match =
    /^(?:npm:)?((?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)(?:@[^\s]+)?$/.exec(source);
  return match && validName(match[1]) ? match[1] : null;
}
function validName(name) {
  return (
    typeof name === "string" &&
    name.length <= 214 &&
    /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name) &&
    !name.split("/").some((part) => part === "." || part === "..")
  );
}

// The official directory publishes HTML, not a versioned public JSON contract.
// Proxy that read-only representation; the browser extracts data with its DOM
// parser after sanitization. Installation and update semantics remain Pi's.
export function createPackageCatalog({
  fetchPage = fetch,
  now = Date.now,
} = {}) {
  const cache = new Map(),
    running = new Map(),
    controllers = new Set();
  let cacheBytes = 0,
    closed = false;
  async function readPage(url, refresh) {
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const response = await fetchPage(url, {
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(CATALOG_TIMEOUT_MS),
        ]),
        headers: {
          Accept: "text/html",
          ...(refresh ? { "Cache-Control": "no-cache" } : {}),
        },
      });
      if (!response.ok)
        throw new DeskError(
          response.status === 404 ? 404 : 502,
          response.status === 404
            ? "pi.dev 官方目录未找到此包"
            : "pi.dev 官方目录暂时不可用",
        );
      if (
        !response.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("text/html")
      )
        throw new DeskError(502, "pi.dev 目录格式已变化，请查看官方页面");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body ?? []) {
        bytes += chunk.byteLength;
        if (bytes > MAX_CATALOG_BYTES)
          throw new DeskError(
            413,
            "官方介绍超过 4 MiB，未截断；请打开 pi.dev 阅读完整页面",
          );
        chunks.push(chunk);
      }
      const html = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      const result = {
        source: "pi.dev",
        sourceUrl: url.href,
        fetchedAt: now(),
        html,
      };
      const previous = cache.get(url.href);
      if (previous) {
        cacheBytes -= previous.bytes;
        cache.delete(url.href);
      }
      while (
        cache.size &&
        (cache.size >= MAX_CACHE_ENTRIES ||
          cacheBytes + bytes > MAX_CACHE_BYTES)
      ) {
        const key = cache.keys().next().value;
        cacheBytes -= cache.get(key).bytes;
        cache.delete(key);
      }
      if (!closed) {
        cache.set(url.href, { result, bytes });
        cacheBytes += bytes;
      }
      return result;
    } catch (error) {
      if (error instanceof DeskError) throw error;
      throw new DeskError(
        502,
        "无法读取 pi.dev 官方目录（网络、超时或连接已关闭），请稍后重试",
      );
    } finally {
      controllers.delete(controller);
    }
  }
  async function load(url, refresh) {
    if (typeof refresh !== "boolean")
      throw new DeskError(422, "目录刷新参数无效");
    if (closed) throw new DeskError(409, "目录连接服务已关闭");
    if (running.has(url.href)) return running.get(url.href);
    const cached = cache.get(url.href);
    if (
      !refresh &&
      cached &&
      now() - cached.result.fetchedAt < CATALOG_CACHE_TTL_MS
    )
      return cached.result;
    if (running.size >= MAX_CONCURRENT_REQUESTS)
      throw new DeskError(429, "目录请求过多，请稍后重试");
    const work = readPage(url, refresh);
    running.set(url.href, work);
    try {
      return await work;
    } finally {
      running.delete(url.href);
    }
  }
  return {
    async list({
      q = "",
      type = "",
      sort = "downloads",
      page = 1,
      refresh = false,
    } = {}) {
      if (
        typeof q !== "string" ||
        q.length > 120 ||
        /[\0-\x1f]/.test(q) ||
        !["", ...types].includes(type) ||
        !sorts.includes(sort) ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 9999
      )
        throw new DeskError(422, "官方目录的搜索、类型、排序或页码无效");
      const url = new URL("/packages", CATALOG_ORIGIN);
      if (q.trim()) url.searchParams.set("name", q.trim());
      if (type) url.searchParams.set("type", type);
      // pi.dev redirects redundant defaults; use its canonical URL rather than
      // relaxing fixed-origin redirect protection.
      if (sort !== "downloads") url.searchParams.set("sort", sort);
      if (page !== 1) url.searchParams.set("page", String(page));
      return { ...(await load(url, refresh)), page, types, sorts };
    },
    async details(name, { refresh = false } = {}) {
      if (!validName(name)) throw new DeskError(422, "官方目录包名无效");
      return load(new URL("/packages/" + name, CATALOG_ORIGIN), refresh);
    },
    async stop() {
      closed = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...running.values()]);
      cache.clear();
      cacheBytes = 0;
    },
  };
}
