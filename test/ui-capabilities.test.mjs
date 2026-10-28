import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHostApi } from "../src/ui-next/host-api.mjs";
import { UI_CHANNELS } from "../src/ui-next/channels.mjs";
import {
  UI_SUPPORT,
  UI_SUBSCRIPTION_SUPPORT,
} from "../src/ui-next/support.mjs";
import { createHttpHandlers } from "../src/ui-next/http-handlers.mjs";
import { createSessionTransport } from "../src/ui-next/session-transport.mjs";
import { desktopFixture } from "./desktop-fixture.mjs";
import { perchoConsumers } from "./percho-fixture.mjs";

test("不支持的 SSH 环境不能把同号会话写入或订阅转交给本地 Host", async (t) => {
  const writes = [],
    subscriptions = [];
  const api = buildHostApi({
    channels: UI_CHANNELS,
    support: UI_SUPPORT,
    subscriptionSupport: UI_SUBSCRIPTION_SUPPORT,
    handlers: {
      "session:prompt": async (input) => {
        writes.push(input);
      },
    },
    subscribe: (...input) => {
      subscriptions.push(input);
      return () => {};
    },
  });
  const previous = globalThis.window;
  globalThis.window = { pi: api };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  const { getExecutionApi, environmentEntityKey } = await perchoConsumers();
  const remote = {
    kind: "ssh",
    connectionId: "fixture-connection",
    environmentId: "fixture-environment",
  };
  const bound = getExecutionApi(remote);
  await assert.rejects(
    () =>
      bound.prompt({
        sessionId: environmentEntityKey(remote, "same-id"),
        text: "remote intent",
      }),
    (error) => error.code === "HOST_API_UNSUPPORTED",
  );
  const off = bound.onEvent(() => {});
  assert.equal(typeof off, "function");
  off();
  assert.deepEqual(writes, []);
  assert.deepEqual(subscriptions, []);
  await getExecutionApi({ kind: "local" }).prompt({
    sessionId: "same-id",
    text: "local intent",
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].text, "local intent");
});

test("空 Host 的模型清单为空，首次会话创建后读取真实清单；读取不偷偷启动 worker", async (t) => {
  const f = await desktopFixture({ defaultConversation: false });
  t.after(() => f.close());
  const io = {
    get: (path) => f.call(path),
    post: (path, input) => f.call(path, input),
  };
  const sessions = createSessionTransport(io),
    h = createHttpHandlers({ ...io, sessions });
  assert.deepEqual(await h["models:list"](), []);
  assert.deepEqual(await h["settings:listProviders"](), []);
  assert.equal((await f.call("/api/workspace")).agents.length, 0);
  const meta = await h["session:create"]({ options: { cwd: f.cwd } });
  assert(meta.sessionId);
  assert(
    (await h["models:list"]()).some(
      (row) => row.provider === "desktop-fixture",
    ),
  );
  assert(
    (await h["settings:listProviders"]()).some(
      (row) => row.id === "desktop-fixture",
    ),
  );
  assert.equal(f.requests.length, 0);
});

test("真实 Host 读取失败不会被伪装成空模型清单", async () => {
  const io = {
    get: async () => {
      throw Object.assign(new Error("fixture unavailable"), { status: 503 });
    },
    post: async () => assert.fail("read must not mutate"),
  };
  const sessions = createSessionTransport(io),
    h = createHttpHandlers({ ...io, sessions });
  for (const channel of ["models:list", "settings:listProviders"])
    await assert.rejects(
      () => h[channel](),
      (error) => error.status === 503,
    );
});
