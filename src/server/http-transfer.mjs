import { Readable, pipeline } from "node:stream";
import { createGzip, createBrotliCompress, constants } from "node:zlib";
import { createHash } from "node:crypto";

export function encodingQuality(header, encoding) {
  const entries = String(header ?? "")
    .toLowerCase()
    .split(",")
    .map((part) => {
      const [name, ...parameters] = part.trim().split(";");
      const quality = parameters.find((value) => value.trim().startsWith("q="));
      const value = quality ? Number(quality.trim().slice(2)) : 1;
      return { name: name.trim(), value: value >= 0 && value <= 1 ? value : 0 };
    });
  const explicit = entries.find((entry) => entry.name === encoding);
  if (explicit) return explicit.value;
  const wildcard = entries.find((entry) => entry.name === "*");
  if (encoding === "identity") return wildcard?.value === 0 ? 0 : 1;
  return wildcard?.value ?? 0;
}

function negotiate(request, bytes = Infinity, brotli = false) {
  const header = request.headers["accept-encoding"];
  const identity = encodingQuality(header, "identity");
  const gzip = encodingQuality(header, "gzip");
  const br = brotli ? encodingQuality(header, "br") : 0;
  if (
    br > 0 &&
    br >= gzip &&
    br >= identity &&
    (bytes >= 1024 || identity === 0)
  )
    return "br";
  if (gzip > 0 && gzip >= identity && (bytes >= 1024 || identity === 0))
    return "gzip";
  return identity > 0 ? "identity" : undefined;
}
function rejectEncoding(response) {
  response.writeHead(406, {
    "Cache-Control": "no-store",
    Vary: "Accept-Encoding",
  });
  response.end();
}

// Private state is compressed for this request only, never put in an asset cache.
export function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  const encoding = negotiate(response.req, body.length, true);
  if (!encoding) return rejectEncoding(response);
  if (status === 200 && ["GET", "HEAD"].includes(response.req.method)) {
    const etag = `W/"${createHash("sha256").update(body).digest("base64url")}"`;
    response.setHeader("ETag", etag);
    if (
      String(response.req.headers["if-none-match"] ?? "")
        .split(",")
        .some(
          (value) =>
            value.trim() === "*" ||
            value.trim().replace(/^W\//, "") === etag.slice(2),
        )
    ) {
      response.writeHead(304, {
        "Cache-Control": "no-store",
        Vary: "Accept-Encoding",
      });
      return response.end();
    }
  }
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Accept-Encoding",
    ...(encoding !== "identity"
      ? { "Content-Encoding": encoding }
      : { "Content-Length": body.length }),
  });
  if (response.req.method === "HEAD") return response.end();
  if (encoding !== "identity") {
    // The threadpool compresses and streams the body without blocking the agent loop.
    pipeline(
      Readable.from([body]),
      encoding === "br"
        ? createBrotliCompress({
            params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
          })
        : createGzip({ level: 3 }),
      response,
      () => {},
    );
  } else response.end(body);
}

// The bridge writes complete SSE frames. Flush each frame so tokens and heartbeats
// reach EventSource immediately, even when the gzip dictionary is not full yet.
export function openEventStream(request, response) {
  const encoding = negotiate(request);
  if (!encoding) {
    rejectEncoding(response);
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    Vary: "Accept-Encoding",
    ...(encoding === "gzip" ? { "Content-Encoding": "gzip" } : {}),
  });
  response.flushHeaders();
  const encoder =
    encoding === "gzip"
      ? createGzip({ level: 3, flush: constants.Z_SYNC_FLUSH })
      : undefined;
  if (encoder) pipeline(encoder, response, () => {});
  const output = encoder ?? response;
  const finished = new Promise((resolve) => {
    response.once("finish", resolve);
    response.once("close", resolve);
  });
  return {
    get writableLength() {
      return (
        response.writableLength +
        (encoder ? encoder.writableLength + encoder.readableLength : 0)
      );
    },
    write(frame) {
      if (output.destroyed || output.writableEnded) return false;
      return output.write(frame);
    },
    end() {
      if (!output.destroyed && !output.writableEnded) output.end();
      return finished;
    },
  };
}
