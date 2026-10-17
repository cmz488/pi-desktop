import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectMessage,
  projectToolEvent,
  usageMetrics,
  statsFromEntries,
} from "../src/shared/conversation.mjs";
import { gitInfo } from "../src/git/workspace-info.mjs";
import { mcpProjection, patchMcp } from "../src/resources/mcp-config.mjs";

test("conversation projection retains thinking and tool correlation while omitting signatures and retaining raw output", () => {
  const message = projectMessage(
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "visible summary",
          thinkingSignature: "private-signature",
        },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "README.md" },
        },
      ],
    },
    "message-1",
  );
  assert.equal(message.blocks[0].text, "visible summary");
  assert.equal(message.blocks[1].id, "call-1");
  assert(!JSON.stringify(message).includes("private-signature"));
  assert.equal(
    projectMessage({
      role: "toolResult",
      toolCallId: "call-1",
      isError: true,
      content: [{ type: "text", text: "x".repeat(90000) }],
    }).text.length,
    90000,
  );
  assert.deepEqual(
    usageMetrics({
      tokens: {
        input: 100,
        output: 200,
        cacheRead: 300,
        cacheWrite: 100,
        total: 700,
      },
      cost: 0.25,
    }),
    {
      total: 700,
      input: 100,
      output: 200,
      cost: 0.25,
      cacheRead: 300,
      cacheWrite: 100,
      cacheHitRate: 0.6,
    },
  );
  assert.equal(usageMetrics().cacheHitRate, null);
});

test("TUI stats include compacted and abandoned entries, summaries, tool usage and standalone usage exactly once", () => {
  const usage = {
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    cost: { total: 0.25 },
  };
  const stats = statsFromEntries([
    { type: "message", message: { role: "user", content: "hello" } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall" }], usage },
    },
    { type: "message", message: { role: "toolResult", usage } },
    { type: "compaction", usage },
    { type: "branch_summary", usage },
    { type: "usage", usage },
    { type: "message", message: { role: "assistant", content: [], usage } },
  ]);
  assert.deepEqual(stats, {
    userMessages: 1,
    assistantMessages: 2,
    toolResults: 1,
    totalMessages: 4,
    toolCalls: 1,
    tokens: {
      input: 60,
      output: 120,
      cacheRead: 180,
      cacheWrite: 240,
      total: 600,
    },
    cost: 1.5,
  });
});

test("Git metrics read a real branch and safely report a directory outside a repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await gitInfo(root), null);
  execFileSync("git", ["init", "--initial-branch=web-fixture", root], {
    stdio: "ignore",
  });
  assert.deepEqual(await gitInfo(root), {
    branch: "web-fixture",
    detached: false,
  });
});

test("MCP edits preserve unknown config and blank secrets while rejecting invalid scopes, transport and names", () => {
  const data = {
    unknown: { keep: true },
    mcpServers: {
      docs: {
        url: "https://example.invalid/mcp",
        headers: { Authorization: "private-token" },
        oauth: {
          clientSecret: "private-secret",
          futureCredential: "do-not-expose",
        },
        future: { keep: true },
      },
    },
  };
  const projection = mcpProjection(data.mcpServers.docs);
  assert(!JSON.stringify(projection).includes("private-token"));
  assert(!JSON.stringify(projection).includes("private-secret"));
  assert(!JSON.stringify(projection).includes("do-not-expose"));
  patchMcp(data, {
    action: "save",
    name: "docs",
    scope: "global",
    config: {
      description: "Docs",
      headers: { Authorization: "" },
      oauth: { clientSecret: "" },
    },
  });
  assert.equal(data.mcpServers.docs.headers.Authorization, "private-token");
  assert.equal(data.mcpServers.docs.oauth.clientSecret, "private-secret");
  assert.deepEqual(data.mcpServers.docs.future, { keep: true });
  assert.throws(() =>
    patchMcp(
      {},
      {
        action: "save",
        name: "constructor",
        scope: "global",
        config: { command: "node" },
      },
    ),
  );
  assert.throws(() =>
    patchMcp(
      {},
      {
        action: "save",
        name: "x",
        scope: "project",
        config: {
          url: "https://example.invalid",
          auth: { provider: "example" },
        },
      },
    ),
  );
  assert.throws(() =>
    patchMcp(
      {},
      {
        action: "save",
        name: "x",
        scope: "global",
        config: { url: "https://example.invalid", type: "sse" },
      },
    ),
  );
  assert.throws(() =>
    patchMcp(
      {},
      {
        action: "save",
        name: "x",
        scope: "global",
        config: { command: "node", env: { TOKEN: "!echo secret" } },
      },
    ),
  );
});

test("tool updates retain parent correlation and stream partialResult before the final output", () => {
  let call = projectToolEvent({
    type: "tool_execution_start",
    toolName: "bash",
    toolCallId: "nested-1",
    parentToolCallId: "script-1",
    args: { command: "pwd" },
  });
  call = projectToolEvent(
    {
      type: "tool_execution_update",
      toolCallId: "nested-1",
      partialResult: { content: [{ type: "text", text: "partial output" }] },
    },
    call,
  );
  assert.equal(call.parentId, "script-1");
  assert.equal(call.output, "partial output");
  assert.equal(call.status, "running");
  call = projectToolEvent(
    {
      type: "tool_execution_end",
      toolCallId: "nested-1",
      result: { content: [{ type: "text", text: "failed output" }] },
      isError: true,
    },
    call,
  );
  assert.equal(call.output, "failed output");
  assert.equal(call.status, "error");
  assert(call.arguments.includes("pwd"));
});

test("MCP OAuth editor can clear visible keys while preserving opaque future fields", () => {
  const data = {
    mcpServers: {
      docs: {
        url: "https://example.invalid/mcp",
        oauth: {
          clientSecret: "private",
          clientId: "remove-me",
          futureCredential: "opaque",
        },
        auth: { provider: "x", futureCredential: "private" },
      },
    },
  };
  assert(
    !JSON.stringify(mcpProjection(data.mcpServers.docs)).includes("private"),
  );
  patchMcp(data, {
    name: "docs",
    action: "save",
    scope: "global",
    config: { oauth: { clientSecret: "" }, auth: { provider: "y" } },
  });
  assert.equal(data.mcpServers.docs.oauth.clientSecret, "private");
  assert.equal(data.mcpServers.docs.oauth.clientId, undefined);
  assert.equal(data.mcpServers.docs.oauth.futureCredential, "opaque");
  assert.equal(data.mcpServers.docs.auth.futureCredential, "private");
});
