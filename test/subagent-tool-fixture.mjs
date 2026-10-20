import assert from "node:assert/strict";
import { desktopFixture, until } from "./desktop-fixture.mjs";

// 只在模型 provider 的输入／输出边界选择工具调用，工具实现与调度都保持真实。
export async function subagentToolFixture(t, options = {}) {
  const calls = new Map();
  const f = await desktopFixture({
    noExtensions: true,
    ...options,
    modelReply: async (input) => {
      const content = input.messages.at(-1)?.content;
      if (input.messages.at(-1)?.role === "user" && calls.has(content))
        return {
          toolCalls: [
            {
              id: `call-${calls.get(content).number}`,
              type: "function",
              function: {
                name: "desk_subagent",
                arguments: JSON.stringify(calls.get(content).args),
              },
            },
          ],
        };
      return (
        (await options.modelReply?.(input)) ?? { text: "NATIVE_TOOL_DONE" }
      );
    },
  });
  t.after(async () => {
    await options.release?.();
    await f.close();
  });
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const actor = await f.command("conversation.create", {
    projectId: project.id,
    name: "原生管理工具",
  });
  const prefix = `/agents/${actor.id}`;
  const parent = (await f.call(`${prefix}/api/state`)).sessionId;
  async function invoke(args, { sessionId = parent, error = false } = {}) {
    const token = `MANAGE_SUBAGENT_${calls.size}`;
    const before = await f.call(`${prefix}/api/state?sessionId=${sessionId}`);
    const oldCount = before.messages.filter(
      (row) => row.toolName === "desk_subagent",
    ).length;
    calls.set(token, { args, number: calls.size });
    await f.call(`${prefix}/api/prompt?sessionId=${sessionId}`, {
      sessionId,
      message: token,
    });
    const state = await until(
      () => f.call(`${prefix}/api/state?sessionId=${sessionId}`),
      (value) =>
        value.idle &&
        value.messages.filter((row) => row.toolName === "desk_subagent")
          .length > oldCount,
    );
    const result = state.messages.findLast(
      (row) => row.toolName === "desk_subagent",
    );
    if (error) return result.text;
    let value;
    assert.doesNotThrow(() => {
      value = JSON.parse(result.text);
    }, `管理工具应返回结构化原生回执，而不是错误：${result.text}`);
    return value;
  }
  return { f, actor, prefix, parent, invoke };
}
