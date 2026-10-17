import { test } from "node:test";
import { mkdtemp, writeFile, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import {
  prepareAttachments,
  attachmentLimits,
  referenceFiles,
} from "../src/server/context-attachments.mjs";
import { createDeskBridge } from "../src/server/bridge.mjs";
import { startWeb } from "../src/server/web.mjs";
import { concurrentFixture, until } from "./concurrent-fixture.mjs";
const upload = (name, bytes, type = "") => ({
  name,
  type,
  data: Buffer.from(bytes).toString("base64"),
});
const settings = { modelInput: ["text", "image"] };

test("local references index large and binary files without inserting bytes or images into model context", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-reference-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'large & "notes".pdf');
  const handle = await open(path, "w");
  await handle.write("%PDF-private-file-content");
  await handle.truncate(50 * 1024 * 1024);
  await handle.close();
  const [index] = await referenceFiles([path]);
  assert.equal(index.size, 50 * 1024 * 1024);
  assert.equal(index.path, path);
  assert.equal(index.data, undefined);
  const context = await prepareAttachments([index], {
    allowReferences: true,
    modelInput: ["text"],
  });
  assert(context.text.includes("path="));
  assert(context.text.includes("&amp; &quot;notes&quot;"));
  assert(!context.text.includes("private-file-content"));
  assert(context.text.length < 1000);
  assert.deepEqual(context.images, []);
  await assert.rejects(
    prepareAttachments([index]),
    (error) => error.status === 403,
  );
  await assert.rejects(
    prepareAttachments([{ ...index, data: "YQ==" }], { allowReferences: true }),
    (error) => error.status === 422,
  );
  for (const paths of [
    ["relative.txt"],
    [directory],
    [path + "\0"],
    [join(directory, "missing")],
  ])
    await assert.rejects(
      referenceFiles(paths),
      (error) => error.status === 422,
    );
});

test("local HTTP chooses metadata references while remote requests upload and cannot open the host picker or reference host paths", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-reference-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "settings.json"), "{}");
  const path = join(directory, "context.txt");
  await writeFile(path, "private host file");
  let picks = 0;
  const received = [];
  const bridge = createDeskBridge({
    agentDir: directory,
    host: "127.0.0.1",
    port: 0,
    snapshot: () => ({
      sessionId: "one",
      cwd: directory,
      model: { input: ["text"] },
      capabilities: { attachments: attachmentLimits },
    }),
    canWrite: () => true,
    prompt: (message, mode, context) => received.push(context),
    filePicker: {
      pickFiles: async () => {
        picks++;
        return [path];
      },
    },
  });
  const url = await bridge.start();
  t.after(() => bridge.stop());
  const origin = new URL(url).origin;
  const call = (route, input, headers = {}) =>
    fetch(new URL(route, url), {
      ...(input ? { method: "POST", body: JSON.stringify(input) } : {}),
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...headers,
      },
    });
  const remote = { "x-pi-remote-client": "1" };
  assert.equal(
    (await (await call("/api/state")).json()).capabilities.attachments
      .defaultMode,
    "reference",
  );
  assert.equal(
    (await (await call("/api/state", undefined, remote)).json()).capabilities
      .attachments.defaultMode,
    "upload",
  );
  const chosen = await (await call("/api/context/files", {})).json();
  assert.equal(chosen.files[0].path, path);
  assert(!JSON.stringify(chosen).includes("private host file"));
  assert.equal(picks, 1);
  assert.equal((await call("/api/context/files", {}, remote)).status, 403);
  assert.equal(
    (await call("/api/context/files", {}, { Origin: "https://other.invalid" }))
      .status,
    403,
  );
  assert.equal(picks, 1);
  assert.equal(
    (
      await call("/api/prompt", {
        message: "review",
        attachments: chosen.files,
      })
    ).status,
    200,
  );
  assert(received[0].text.includes(path));
  assert(!received[0].text.includes("private host file"));
  assert.equal(
    (
      await call(
        "/api/prompt",
        { message: "review", attachments: chosen.files },
        remote,
      )
    ).status,
    403,
  );
  assert.equal(received.length, 1);
  assert.equal(
    (
      await call(
        "/api/prompt",
        {
          message: "review",
          attachments: [upload("phone.txt", "phone upload")],
        },
        remote,
      )
    ).status,
    200,
  );
  assert(received[1].text.includes("phone upload"));
});

test("context uploads preserve UTF-8/code bytes and use Pi's real image decode/resize", async () => {
  const text = await prepareAttachments([
    upload('notes & "draft".md', "\ufeff# 中文\n<untrusted>"),
    upload("code.svg", "<svg></svg>", "image/svg+xml"),
  ]);
  assert(text.text.includes('name="notes &amp; &quot;draft&quot;.md"'));
  assert(text.text.includes("# 中文\n<untrusted>"));
  assert(!text.text.includes("\ufeff"));
  const png = await QRCode.toBuffer("context fixture");
  const image = await prepareAttachments(
    [upload("image.png", png, "image/png")],
    settings,
  );
  assert.equal(image.images[0].type, "image");
  assert.equal(image.images[0].mimeType, "image/png");
  assert.deepEqual(image.names, ["image.png"]);
  await assert.rejects(
    () =>
      prepareAttachments([upload("image.png", png)], { modelInput: ["text"] }),
    (error) => error.status === 422 && error.message.includes("模型"),
  );
  await assert.rejects(
    () =>
      prepareAttachments([upload("image.png", png)], {
        ...settings,
        blockImages: true,
      }),
    (error) => error.status === 422,
  );
});
test("unsupported, malformed, binary, oversized and path-shaped uploads fail explicitly", async () => {
  for (const files of [
    [upload("paper.pdf", "%PDF-1.7")],
    [upload("paper.docx", "PK\x03\x04")],
    [upload("fake.md", "%PDF-1.7")],
    [upload("binary.txt", Buffer.from([0, 1, 2]))],
    [upload("bad.txt", Buffer.from([0xff, 0xfe]))],
    [upload("../secret.txt", "data")],
    [{ name: "broken.txt", data: "not-base64!" }],
    [upload("fake.png", "not a real picture", "image/png")],
    Array.from({ length: attachmentLimits.maxCount + 1 }, () =>
      upload("file.txt", "x"),
    ),
  ])
    await assert.rejects(
      () => prepareAttachments(files, settings),
      (error) => error.status === 422,
    );
  await assert.rejects(
    () =>
      prepareAttachments([
        upload("huge.txt", "x".repeat(attachmentLimits.maxTextBytes + 1)),
      ]),
    (error) => error.status === 413,
  );
  const png = await QRCode.toBuffer("fixture");
  // Reject a decompression bomb's dimensions before passing bytes to WASM.
  png.writeUInt32BE(100_000, 16);
  png.writeUInt32BE(100_000, 20);
  await assert.rejects(
    () => prepareAttachments([upload("huge.png", png)], settings),
    (error) => error.status === 422 && error.message.includes("3200"),
  );
});
test("attachment HTTP rechecks focus after image-worker awaits and never sends to a different session", async (t) => {
  let id = "A",
    calls = 0;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-context-http-"));
  await writeFile(join(agentDir, "settings.json"), "{}");
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const bridge = createDeskBridge({
    agentDir,
    host: "127.0.0.1",
    port: 0,
    snapshot: () => ({
      sessionId: id,
      model: {
        get input() {
          // The route has captured A before reading image metadata. Queue the
          // switch across preparation's await, not before HTTP arrival on a timer.
          queueMicrotask(() => (id = "B"));
          return ["text", "image"];
        },
      },
    }),
    prompt: () => calls++,
    canWrite: () => true,
  });
  const url = await bridge.start();
  t.after(() => bridge.stop());
  const png = await QRCode.toBuffer("focus fixture");
  const response = fetch(new URL("/api/prompt", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Context",
      attachments: [upload("image.png", png)],
    }),
  });
  assert.equal((await response).status, 409);
  assert.equal(calls, 0);
});
test("real SDK prompt receives text and image content, and attachment-only prompts are supported", async (t) => {
  const fixture = await concurrentFixture();
  const app = await startWeb({
    cwd: fixture.root,
    agentDir: fixture.agentDir,
    port: 0,
    noExtensions: true,
  });
  await app.ready;
  t.after(async () => {
    await app.stop();
    await fixture.stop();
  });
  fixture.release("C");
  const png = await QRCode.toBuffer("real sdk context");
  const response = await fetch(new URL("/api/prompt", app.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "",
      sessionId: app.manager.focusId,
      attachments: [
        upload("notes.md", "context text"),
        upload("image.png", png),
      ],
    }),
  });
  assert.equal(response.status, 200, await response.text());
  await until(() =>
    app.runtime.session.messages.some((message) => message.role === "user"),
  );
  const user = app.runtime.session.messages.find(
    (message) => message.role === "user",
  );
  assert(
    user.content.some(
      (block) =>
        block.type === "text" &&
        block.text.includes("context text") &&
        block.text.includes('name="image.png"'),
    ),
  );
  assert(
    user.content.some(
      (block) => block.type === "image" && block.mimeType === "image/png",
    ),
  );
  await until(() => app.runtime.session.isIdle);
});
