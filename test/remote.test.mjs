import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createDeskBridge } from "../src/server/bridge.mjs";
import jsQR from "jsqr";
import { PNG } from "pngjs";

async function fixture(t, tls = false) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-shared-"));
  const options = {};
  let ca;
  if (tls) {
    const certPath = join(dir, "cert.pem"),
      keyPath = join(dir, "key.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=Pi Web test",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ],
      { stdio: "ignore" },
    );
    Object.assign(options, { certPath, keyPath });
    ca = await readFile(certPath);
  }
  await writeFile(join(dir, "settings.json"), "{}");
  const messages = [];
  const bridge = createDeskBridge({
    ...options,
    port: 0,
    agentDir: dir,
    lanAddresses: () => ["192.168.55.23", "10.8.0.2"],
    snapshot: () => ({ models: [], messages }),
    canWrite: () => true,
    prompt: (message) => {
      messages.push({ role: "user", text: message });
    },
    capabilities: { prompt: true, canWrite: true, remote: true },
  });
  const local = new URL(await bridge.start());
  t.after(async () => {
    await bridge.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const call = (path, input, host = local.host) =>
    new Promise((resolve, reject) => {
      const req = (tls ? httpsRequest : httpRequest)(
        local.origin + path,
        {
          ca,
          method: input === undefined ? "GET" : "POST",
          headers: { Host: host, "Content-Type": "application/json" },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              data: JSON.parse(text),
              headers: res.headers,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(input === undefined ? undefined : JSON.stringify(input));
    });
  return { bridge, local, call, messages };
}
for (const tls of [false, true])
  test(`${tls ? "HTTPS" : "HTTP"} QR opens a persistent shared URL on the same port; PC and phone both send without credentials`, async (t) => {
    const f = await fixture(t, tls);
    const desktop = await f.call("/api/state");
    assert.equal(desktop.status, 200);
    assert.equal(desktop.headers["set-cookie"], undefined);
    assert(
      !("role" in desktop.data) &&
        !("owner" in desktop.data) &&
        !("csrf" in desktop.data),
    );
    const remote = await f.call("/api/remote");
    const info = remote.data,
      phone = new URL(info.url);
    const png = PNG.sync.read(Buffer.from(info.qr.split(",")[1], "base64"));
    assert.equal(
      jsQR(new Uint8ClampedArray(png.data), png.width, png.height).data,
      info.url,
    );
    assert.equal(phone.port, f.local.port);
    assert.equal(phone.hash, "");
    assert.equal(phone.search, "");
    assert.equal(info.urls.length, 2);
    assert(!("expiresIn" in info));
    assert.equal(
      (await f.call("/api/prompt", { message: "phone message" }, phone.host))
        .status,
      200,
    );
    assert.equal(
      (await f.call("/api/prompt", { message: "desktop message" })).status,
      200,
    );
    assert.deepEqual(
      (await f.call("/api/state", undefined, phone.host)).data.messages,
      (await f.call("/api/state")).data.messages,
    );
    assert.equal(f.messages.length, 2);
    assert.equal(
      (await f.call("/api/providers", undefined, phone.host)).status,
      200,
    );
    assert.equal(
      (await f.call("/api/remote")).data.url,
      info.url,
      "Refreshing does not replace the access URL",
    );
    assert.equal(
      (await f.call(`/api/remote?address=${encodeURIComponent(info.urls[1])}`))
        .data.url,
      info.urls[1],
    );
  });

test("two unauthenticated event streams receive the same ordered session updates", async (t) => {
  const f = await fixture(t);
  const firstAbort = new AbortController(),
    secondAbort = new AbortController();
  t.after(() => {
    firstAbort.abort();
    secondAbort.abort();
  });
  const state = (await f.call("/api/state")).data;
  const endpoint = `${f.local.origin}/api/events?after=${state.seq}&epoch=${state.epoch}`;
  const [first, second] = await Promise.all([
    fetch(endpoint, { signal: firstAbort.signal }),
    fetch(endpoint, { signal: secondAbort.signal }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  function reader(stream) {
    const input = stream.getReader(),
      decoder = new TextDecoder();
    let text = "";
    return async () => {
      for (;;) {
        const end = text.indexOf("\n\n");
        if (end >= 0) {
          const frame = text.slice(0, end);
          text = text.slice(end + 2);
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (data) return JSON.parse(data.slice(6));
          continue;
        }
        const chunk = await input.read();
        if (chunk.done) throw new Error("stream ended");
        text += decoder.decode(chunk.value, { stream: true });
      }
    };
  }
  const desktop = reader(first.body),
    phone = reader(second.body);
  await f.call("/api/prompt", { message: "from desktop" });
  assert.deepEqual(await desktop(), await phone());
  await f.call("/api/prompt", { message: "from phone" });
  assert.deepEqual(await desktop(), await phone());
  firstAbort.abort();
  secondAbort.abort();
});
