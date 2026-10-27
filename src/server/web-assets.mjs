import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip, brotliCompress, constants } from "node:zlib";
import { encodingQuality } from "./http-transfer.mjs";

import { assetFile, sharedAssets, publicAssets, nextPageAssets } from "./asset-manifest.mjs";
export { publicAssets, nextPageAssets };
export const richAssets = sharedAssets;
const compress = promisify(gzip);
const compressBrotli = promisify(brotliCompress);
const COMPRESSION_MIN_BYTES = 1024;
const digest = (body) => createHash("sha256").update(body).digest("hex");

// Only public, allowlisted assets enter this cache. Session JSON and SSE never do.
// Revalidate on every navigation so edits and upgrades cannot leave stale modules.
export function createStaticAssetHandler(
  files,
  { transform = (body) => body } = {},
) {
  const cache = new Map();
  return async (request, response, pathname) => {
    const asset = files.get(pathname);
    if (!asset || !["GET", "HEAD"].includes(request.method)) return false;
    const [file, type] = asset;
    const url = assetFile(file);
    const info = await stat(url, { bigint: true });
    const signature = `${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
    let entry = cache.get(pathname);
    if (!entry || entry.signature !== signature) {
      entry = {
        signature,
        content: readFile(url).then((body) => {
          const content = transform(body, type);
          return { body: content, etag: `"${digest(content)}"` };
        }),
      };
      cache.set(pathname, entry);
    }
    let content;
    try {
      content = await entry.content;
    } catch (error) {
      if (cache.get(pathname) === entry) cache.delete(pathname);
      throw error;
    }
    const compressible = /^(text\/|application\/json)/.test(type);
    const identityQuality = encodingQuality(
      request.headers["accept-encoding"],
      "identity",
    );
    const gzipQuality = encodingQuality(
      request.headers["accept-encoding"],
      "gzip",
    );
    const brQuality = encodingQuality(request.headers["accept-encoding"], "br");
    const useBr =
      compressible &&
      brQuality > 0 &&
      brQuality >= gzipQuality &&
      brQuality >= identityQuality &&
      (content.body.length >= COMPRESSION_MIN_BYTES || identityQuality === 0);
    const useGzip =
      !useBr &&
      compressible &&
      gzipQuality > 0 &&
      gzipQuality >= identityQuality &&
      (content.body.length >= COMPRESSION_MIN_BYTES || identityQuality === 0);
    if (!useGzip && !useBr && identityQuality === 0) {
      response.writeHead(406, {
        "Cache-Control": "no-store",
        Vary: "Accept-Encoding",
      });
      response.end();
      return true;
    }
    let body = content.body;
    let etag = content.etag;
    if (useGzip || useBr) {
      const key = useBr ? "brotli" : "compressed";
      content[key] ??= (
        useBr
          ? compressBrotli(body, {
              params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
            })
          : compress(body)
      )
        .then((compressed) => ({
          body: compressed,
          etag: `"${digest(compressed)}"`,
        }))
        .catch((error) => {
          content[key] = undefined;
          throw error;
        });
      ({ body, etag } = await content[key]);
    }
    const headers = {
      "Content-Type":
        compressible && !type.includes("charset=")
          ? `${type}; charset=utf-8`
          : type,
      "Cache-Control": "no-cache",
      Vary: "Accept-Encoding",
      ETag: etag,
      ...(useBr
        ? { "Content-Encoding": "br" }
        : useGzip
          ? { "Content-Encoding": "gzip" }
          : {}),
    };
    const validators = String(request.headers["if-none-match"] ?? "").split(
      ",",
    );
    if (
      validators.some(
        (value) =>
          value.trim() === "*" || value.trim().replace(/^W\//, "") === etag,
      )
    ) {
      response.writeHead(304, headers);
      response.end();
    } else {
      response.writeHead(200, { ...headers, "Content-Length": body.length });
      response.end(request.method === "HEAD" ? undefined : body);
    }
    return true;
  };
}
