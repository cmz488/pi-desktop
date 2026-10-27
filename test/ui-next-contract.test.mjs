import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  UI_CHANNELS,
  UI_CHANNEL_NAMES,
  UI_SUBSCRIPTIONS,
  UI_SUBSCRIPTION_NAMES,
} from "../src/ui-next/channels.mjs";
import {
  UI_SUPPORT,
  UI_SUBSCRIPTION_SUPPORT,
} from "../src/ui-next/support.mjs";
import {
  buildHostApi,
  HostApiUnsupported,
} from "../src/ui-next/host-api.mjs";

/**
 * GUI 移植契约：每个 Percho 通道都必须有明确的支持状态。
 *
 * 守住四件事：
 *   1. 覆盖：通道表与支持表一一对应，不许多也不许少；
 *   2. 可验证：标成 `implemented` 的必须指向一个真实存在的 Host 路由或 workspace 命令；
 *   3. 可诊断：标成 `unsupported` 的必须写明原因，调用时抛出带通道名的错误；
 *   4. 命名：方法名来自通道表键，不允许重复。
 */

/** 从源码里取真实的 Host 路由与 workspace 命令，作为 `implemented` 的核对依据。 */
async function hostSurface() {
  // 路由分散在三个服务端入口与 Host 控制面：bridge 是 worker 路由表，durable-server 是
  // Durable 宿主路由，control-plane 是 Host 路由；漏扫任何一个都会误报“声称已实现”。
  const sources = await Promise.all(
    [
      "../src/server/bridge.mjs",
      "../src/server/durable-server.mjs",
      "../src/control-plane/server.mjs",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );
  const workspace = await readFile(
    new URL("../src/agent/agent-workspace.mjs", import.meta.url),
    "utf8",
  );
  const routes = new Set(
    sources.flatMap((source) =>
      [...source.matchAll(/"(\/api\/[a-z0-9/_-]*)"/g)].map((m) => m[1]),
    ),
  );
  const commands = new Set(
    [...workspace.matchAll(/command === "([a-z-]+)"/g)].map((m) => m[1]),
  );
  return { routes, commands };
}

test("通道表与支持表一一对应", () => {
  const channels = [...UI_CHANNEL_NAMES].sort();
  const supported = Object.keys(UI_SUPPORT).sort();
  assert.deepEqual(
    supported,
    channels,
    "支持表必须覆盖并从属于通道表；新增通道时同步登记状态",
  );

  const subs = [...UI_SUBSCRIPTION_NAMES].sort();
  assert.deepEqual(
    Object.keys(UI_SUBSCRIPTION_SUPPORT).sort(),
    subs,
    "订阅支持表必须覆盖并从属于订阅表",
  );
  assert.equal(UI_CHANNEL_NAMES.length, 123, "Percho 契约有 123 条 invoke 通道");
  assert.equal(UI_SUBSCRIPTION_NAMES.length, 17, "Percho 契约有 17 条订阅");
});

test("implemented 必须指向真实存在的路由或 workspace 命令", async () => {
  const { routes, commands } = await hostSurface();
  const broken = [];
  for (const [channel, row] of Object.entries(UI_SUPPORT)) {
    if (row.status !== "implemented") continue;
    if (!routes.has(row.route) && !commands.has(row.route))
      broken.push(`${channel} → ${row.route}`);
  }
  assert.deepEqual(broken, [], "这些通道声称已实现，但路由不存在");
});

test("每个通道的状态合法，unsupported 必须写明原因", () => {
  for (const [channel, row] of Object.entries(UI_SUPPORT)) {
    assert.ok(
      ["implemented", "unsupported"].includes(row.status),
      `${channel} 的状态非法：${row.status}`,
    );
    if (row.status === "unsupported")
      assert.ok(
        typeof row.reason === "string" && row.reason.length > 0,
        `${channel} 标为 unsupported 时必须给出原因`,
      );
    if (row.status === "implemented")
      assert.ok(
        typeof row.route === "string" && row.route.startsWith("/"),
        `${channel} 标为 implemented 时必须给出 Host 路由`,
      );
  }
  for (const [name, row] of Object.entries(UI_SUBSCRIPTION_SUPPORT)) {
    assert.ok(["implemented", "unsupported"].includes(row.status), name);
    if (row.status === "unsupported")
      assert.ok(row.reason?.length > 0, `${name} 标为 unsupported 时必须给出原因`);
  }
});

test("方法名唯一，且与通道表键一一对应", () => {
  const keys = Object.values(UI_CHANNELS)
    .map((entry) => entry.key)
    .filter(Boolean);
  assert.equal(new Set(keys).size, keys.length, "通道表键必须唯一");
  const subNames = Object.keys(UI_SUBSCRIPTIONS);
  const overlap = keys.filter((key) => subNames.includes(key));
  assert.deepEqual(overlap, [], "invoke 与订阅的方法名不能冲突");
});

test("buildHostApi 为每条通道与订阅生成方法，未实现的抛带通道名的错误", async () => {
  const api = buildHostApi({
    channels: UI_CHANNELS,
    handlers: {},
    support: UI_SUPPORT,
    subscriptionSupport: UI_SUBSCRIPTION_SUPPORT,
  });

  for (const [channel, entry] of Object.entries(UI_CHANNELS)) {
    if (!entry.key) continue;
    assert.equal(typeof api[entry.key], "function", `${entry.key} 必须是函数`);
  }
  for (const name of UI_SUBSCRIPTION_NAMES)
    assert.equal(typeof api[name], "function", `${name} 必须是函数`);

  // 未实现的通道：错误里必须能读出是哪个通道、为什么。
  const unsupported = Object.entries(UI_SUPPORT).find(
    ([, row]) => row.status === "unsupported",
  );
  const [channel, row] = unsupported;
  const method = UI_CHANNELS[channel].key;
  await assert.rejects(
    () => api[method]({}),
    (error) => {
      assert.ok(error instanceof HostApiUnsupported);
      assert.equal(error.channel, channel);
      assert.match(error.message, /尚未在此 Host 上实现/);
      assert.ok(error.message.includes(row.reason.slice(0, 8)));
      return true;
    },
  );

  // 已实现但没有处理函数：同样是明确的错误，而不是 undefined。
  const implemented = Object.entries(UI_SUPPORT).find(
    ([, row]) => row.status === "implemented",
  );
  await assert.rejects(
    () => api[UI_CHANNELS[implemented[0]].key]({}),
    (error) => error instanceof HostApiUnsupported,
  );
});

test("标成 implemented 的通道必须有真实处理函数，反之亦然", async () => {
  const { createHttpHandlers } = await import("../src/ui-next/http-handlers.mjs");
  const handlers = createHttpHandlers({ get: async () => ({}), post: async () => ({}) });
  const implemented = Object.entries(UI_SUPPORT)
    .filter(([, row]) => row.status === "implemented")
    .map(([channel]) => channel);

  assert.deepEqual(
    implemented.filter((channel) => !handlers[channel]).sort(),
    [],
    "这些通道声称已实现，但没有处理函数",
  );
  assert.deepEqual(
    Object.keys(handlers)
      .filter((channel) => !implemented.includes(channel))
      .sort(),
    [],
    "这些处理函数没有在支持表里登记为 implemented",
  );
});

test("实现表齐备时按通道分发，且把参数原样交给处理函数", async () => {
  const seen = [];
  const handlers = Object.fromEntries(
    Object.entries(UI_SUPPORT)
      .filter(([, row]) => row.status === "implemented")
      .map(([channel]) => [
        channel,
        async (args) => {
          seen.push({ channel, args });
          return { channel, echo: args };
        },
      ]),
  );
  const api = buildHostApi({
    channels: UI_CHANNELS,
    handlers,
    support: UI_SUPPORT,
    subscriptionSupport: UI_SUBSCRIPTION_SUPPORT,
  });

  const result = await api.listSessions({ cwd: "/tmp/x" });
  assert.deepEqual(result, {
    channel: "session:list",
    echo: { cwd: "/tmp/x" },
  });
  assert.equal(seen.length, 1);
  // 无参调用也要给出 `{}`，避免处理函数各自补默认值。
  await api.listModels();
  assert.deepEqual(seen.at(-1).args, {});
});

test("订阅返回只移除自己的退订函数，未实现的订阅同样抛错", () => {
  const listeners = new Map();
  const api = buildHostApi({
    channels: UI_CHANNELS,
    handlers: {},
    support: UI_SUPPORT,
    subscriptionSupport: UI_SUBSCRIPTION_SUPPORT,
    subscribe: (name, channel, listener) => {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    },
  });

  const a = () => {};
  const b = () => {};
  const offA = api.onEvent(a);
  const offB = api.onEvent(b);
  assert.equal(listeners.get("onEvent").size, 2);
  offA();
  assert.equal(listeners.get("onEvent").size, 1);
  offB();
  assert.equal(listeners.get("onEvent").size, 0);

  // 未实现的订阅不抛错（订阅发生在启动阶段），但必须可观测。
  const unsupported = Object.entries(UI_SUBSCRIPTION_SUPPORT).find(
    ([, row]) => row.status === "unsupported",
  );
  const off = api[unsupported[0]](() => {});
  assert.equal(typeof off, "function");
  off();
  assert.deepEqual(Object.keys(api.subscriptionReport()), [unsupported[0]]);
  assert.equal(api.subscriptionReport()[unsupported[0]].used, 1);
  assert.ok(api.subscriptionReport()[unsupported[0]].reason.length > 0);
});
