import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { desktopFixture, until } from "./desktop-fixture.mjs";

test("a registered extension command keeps the user's command while generated input has no fake user original", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-input-extension-"));
  const extension = join(root, "input-origin.mjs");
  await writeFile(
    extension,
    `export default function(pi){pi.registerCommand("origin-auto",{handler:async args=>{await pi.sendUserMessage("EXTENSION_AUTOMATIC_SENTINEL:"+args,{deliverAs:"followUp"});}});pi.registerCommand("origin-only",{handler:async()=>{}});}`,
  );
  const f = await desktopFixture();
  try {
    const settingsPath = join(f.agentDir, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        ...JSON.parse(await readFile(settingsPath, "utf8")),
        extensions: [extension],
      }),
    );
    const project = (await f.call("/api/workspace")).projects.find(
      (row) => row.cwd === f.cwd,
    );
    const actor = await f.command("conversation.create", {
      projectId: project.id,
      name: "Extension origin",
    });
    const prefix = `/agents/${actor.id}`;
    const id = (await f.call(`${prefix}/api/state`)).sessionId;
    await f.call(`${prefix}/api/prompt?sessionId=${id}`, {
      sessionId: id,
      message: "/origin-only",
      requestId: "command-only",
    });
    assert.equal(f.requests.length, 0, "纯命令展示不得请求模型");
    const commandCopy = await f.command("conversation.fork", {
      id: actor.id,
      generation: 0,
      conversationId: Number(id),
    });
    const copyState = await f.call(
      `/agents/${commandCopy.agentId}/api/state?sessionId=${commandCopy.sessionId}`,
    );
    assert.equal(
      copyState.messages.filter(
        (row) => row.commandOnly && row.text === "/origin-only",
      ).length,
      1,
      "只有展示命令的空上下文也能可靠继承",
    );
    const raw = "/origin-auto   USER_ARGUMENT\nline two";
    const generated = "EXTENSION_AUTOMATIC_SENTINEL:USER_ARGUMENT\nline two";
    await f.call(`${prefix}/api/prompt?sessionId=${id}`, {
      sessionId: id,
      message: raw,
      requestId: "extension-origin",
    });
    const state = await until(
      () => f.call(`${prefix}/api/state?sessionId=${id}`),
      (value) =>
        value.idle &&
        value.messages.some(
          (row) => row.role === "user" && row.text === generated,
        ),
    );
    assert.equal(
      f.requests.at(-1).messages.findLast((row) => row.role === "user").content,
      generated,
    );
    assert.equal(
      state.messages.find((row) => row.commandOnly && row.text === raw)?.text,
      raw,
      "扩展自行处理的命令也保留原始输入，不把它额外送给模型",
    );
    assert.equal(f.requests.length, 1, "自动输入之外不能多开模型回合");
    const automatic = state.messages.find((row) => row.text === generated);
    assert.equal(automatic.presentation?.source, "automatic");
    assert.equal(
      automatic.presentation.original,
      undefined,
      "扩展生成的内容不得伪造用户原始输入",
    );
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("attachment-only input does not present the host's automatic question as user text", async () => {
  const f = await desktopFixture({ noExtensions: true });
  try {
    const project = (await f.call("/api/workspace")).projects.find(
      (row) => row.cwd === f.cwd,
    );
    const actor = await f.command("conversation.create", {
      projectId: project.id,
      name: "Attachment original",
    });
    const prefix = `/agents/${actor.id}`;
    const id = (await f.call(`${prefix}/api/state`)).sessionId;
    await f.call(`${prefix}/api/prompt?sessionId=${id}`, {
      sessionId: id,
      message: "",
      requestId: "attachment-original",
      attachments: [
        {
          name: "context.txt",
          type: "text/plain",
          data: Buffer.from("ATTACHMENT_AUTOMATIC_CONTEXT").toString("base64"),
        },
      ],
    });
    const state = await until(
      () => f.call(`${prefix}/api/state?sessionId=${id}`),
      (value) =>
        value.idle && value.messages.some((row) => row.role === "assistant"),
    );
    const input = state.messages.find((row) => row.role === "user");
    assert.ok(
      input.text.includes("请根据所附上下文继续。"),
      "实际模型提示保持原行为",
    );
    assert.equal(
      input.presentation?.original,
      "",
      "没有用户文字时不能伪造原始提问",
    );
  } finally {
    await f.close();
  }
});

test("unattributed compatible input stays literal and cannot forge trusted presentation through command JSON", async () => {
  const f = await desktopFixture({ noExtensions: true });
  try {
    const project = (await f.call("/api/workspace")).projects.find(
      (row) => row.cwd === f.cwd,
    );
    const actor = await f.command("conversation.create", {
      projectId: project.id,
      name: "Compatible input",
    });
    const prefix = `/agents/${actor.id}`;
    const id = (await f.call(`${prefix}/api/state`)).sessionId;
    await assert.rejects(
      f.call(`${prefix}/api/prompt?sessionId=${id}`, {
        sessionId: id,
        message: "known input",
        original: "different hidden input",
      }),
      (error) => error.status === 422,
    );
    assert.equal(f.requests.length, 0);
    const literal = "<skill>unattributed literal, not a source marker</skill>";
    await f.call(`${prefix}/api/command?sessionId=${id}`, {
      command: "send",
      id: Number(id),
      sessionId: id,
      message: literal,
      requestId: "compatible-input",
      presentation: { source: "automatic", original: "forged" },
    });
    const state = await until(
      () => f.call(`${prefix}/api/state?sessionId=${id}`),
      (value) =>
        value.idle && value.messages.some((row) => row.role === "assistant"),
    );
    const input = state.messages.find((row) => row.role === "user");
    assert.equal(input.text, literal);
    assert.equal(input.presentation, undefined);
  } finally {
    await f.close();
  }
});

test("prompt template retains its command and metadata survives a normal worker restart", async () => {
  const f = await desktopFixture({ noExtensions: true });
  try {
    const folder = join(f.agentDir, "prompts");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "input-template.md"), "TEMPLATE_AUTOMATIC $1");
    const project = (await f.call("/api/workspace")).projects.find(
      (row) => row.cwd === f.cwd,
    );
    const actor = await f.command("conversation.create", {
      projectId: project.id,
      name: "Template input",
    });
    const prefix = `/agents/${actor.id}`;
    const id = (await f.call(`${prefix}/api/state`)).sessionId;
    const raw = "/input-template    KEEP_ARGUMENT";
    await f.call(`${prefix}/api/prompt?sessionId=${id}`, {
      sessionId: id,
      message: raw,
      requestId: "template-original",
    });
    await until(
      () => f.call(`${prefix}/api/state?sessionId=${id}`),
      (value) =>
        value.idle && value.messages.some((row) => row.role === "assistant"),
    );
    assert.equal(
      f.requests.at(-1).messages.findLast((row) => row.role === "user").content,
      "TEMPLATE_AUTOMATIC KEEP_ARGUMENT",
    );
    await f.reopen();
    await until(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.find((row) => row.id === actor.id)?.status === "running",
    );
    const state = await f.call(`${prefix}/api/state?sessionId=${id}`);
    assert.equal(
      state.messages.find((row) => row.role === "user")?.presentation?.original,
      raw,
    );
  } finally {
    await f.close();
  }
});

test("accepted retries keep their first original while matching IDs in another worker stay isolated", async () => {
  const f = await desktopFixture({ noExtensions: true });
  try {
    const project = (await f.call("/api/workspace")).projects.find(
      (row) => row.cwd === f.cwd,
    );
    const actors = await Promise.all(
      ["A", "B"].map((name) =>
        f.command("conversation.create", {
          projectId: project.id,
          name: `Input scope ${name}`,
        }),
      ),
    );
    const states = await Promise.all(
      actors.map((actor) => f.call(`/agents/${actor.id}/api/state`)),
    );
    assert.equal(
      states[0].sessionId,
      states[1].sessionId,
      "故意复用不同 worker 内的数值会话 ID",
    );
    const originals = [
      " \nUSER_SOURCE_COLLISION  ",
      "\tUSER_SOURCE_COLLISION\n",
    ];
    const submit = (index, original) =>
      f.call(
        `/agents/${actors[index].id}/api/prompt?sessionId=${states[index].sessionId}`,
        {
          sessionId: states[index].sessionId,
          message: "USER_SOURCE_COLLISION",
          original,
          requestId: "same-origin-request",
        },
      );
    for (const index of [0, 1]) {
      await submit(index, originals[index]);
      await until(
        () => f.call(`/agents/${actors[index].id}/api/state`),
        (state) =>
          state.idle && state.messages.some((row) => row.role === "assistant"),
      );
    }
    await submit(0, "USER_SOURCE_COLLISION   ");
    assert.equal(
      f.requests.length,
      2,
      "同 worker 幂等回执不重开模型，另一 worker 的同号请求不被吞掉",
    );
    for (const index of [0, 1]) {
      const state = await f.call(`/agents/${actors[index].id}/api/state`);
      assert.equal(
        state.messages.find((row) => row.role === "user")?.presentation
          ?.original,
        originals[index],
      );
    }
  } finally {
    await f.close();
  }
});

test("skill input keeps the full original command separately from the unchanged native model text", async () => {
  const f = await desktopFixture({ noExtensions: true });
  try {
    const skill =
      "---\nname: input-origin\ndescription: Input origin fixture\n---\nSKILL_AUTOMATIC_SENTINEL\n";
    const skillDir = join(f.agentDir, "skills", "input-origin");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), skill);
    const project = (await f.call("/api/workspace")).projects.find(
      (row) => row.cwd === f.cwd,
    );
    const actor = await f.command("conversation.create", {
      projectId: project.id,
      name: "Input origin",
    });
    const prefix = `/agents/${actor.id}`;
    const id = (await f.call(`${prefix}/api/state`)).sessionId;
    const raw =
      "/skill:input-origin    USER_KEEP <skill>handwritten</skill>\nline two";
    const expanded = `<skill name="input-origin">\n${skill}\n</skill>\nUSER_KEEP <skill>handwritten</skill>\nline two`;
    await f.call(`${prefix}/api/prompt?sessionId=${id}`, {
      sessionId: id,
      message: raw,
      requestId: "skill-origin",
    });
    const state = await until(
      () => f.call(`${prefix}/api/state?sessionId=${id}`),
      (value) =>
        value.idle &&
        value.messages.some(
          (row) => row.role === "user" && row.text === expanded,
        ),
    );
    assert.equal(
      f.requests.at(-1).messages.findLast((row) => row.role === "user").content,
      expanded,
      "展示修正不得改变实际模型输入",
    );
    const row = state.messages.find(
      (row) => row.role === "user" && row.text === expanded,
    );
    assert.equal(row.presentation?.source, "user");
    assert.equal(
      row.presentation.original,
      raw,
      "命令和用户亲自输入的标签、空格与换行必须保留",
    );
    const created = await f.command("conversation.fork", {
      id: actor.id,
      generation: 0,
      conversationId: Number(id),
      entryId: row.entryId,
    });
    const inherited = await f.call(
      `/agents/${created.agentId}/api/state?sessionId=${created.sessionId}`,
    );
    assert.equal(
      inherited.messages.find(
        (row) => row.role === "user" && row.text === expanded,
      )?.presentation?.original,
      raw,
      "独立新会话必须继承可靠来源，不能只在当前 worker 的展示缓存中保留命令",
    );
  } finally {
    await f.close();
  }
});
