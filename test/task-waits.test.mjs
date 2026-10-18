import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  awaitWithContext,
} from "@earendil-works/chord/context";
import { createTaskWaits } from "../src/server/task-waits.mjs";
import { sendJson } from "../src/server/http-transfer.mjs";

const LEASE_MS = 60;
const observe = (promise, signal) =>
  awaitWithContext(promise, withAbortSignal(signal, BACKGROUND_CONTEXT));
async function fixture(t, options = {}) {
  const waits = createTaskWaits({ leaseMs: LEASE_MS, ...options });
  const task = Promise.withResolvers();
  const entered = [];
  const server = createServer(async (request, response) => {
    try {
      for await (const _ of request) {
        /* 请求体结束不代表客户端断开。 */
      }
      const value = await waits.run(request, response, (signal) => {
        entered.push(signal);
        return observe(task.promise, signal);
      });
      sendJson(response, 200, value);
    } catch (error) {
      if (!response.destroyed)
        sendJson(response, error.status ?? 500, { error: error.message });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    task.resolve({ ended: true });
    await waits.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    waits,
    task,
    entered,
    request: (signal) => fetch(url, { method: "POST", body: "{}", signal }),
  };
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), "等待 HTTP 观察者状态变化");
}

test("HTTP 等待到期明确返回 408，不假报终态；续租能读取真正结果", async (t) => {
  const f = await fixture(t);
  let ended = false;
  void f.task.promise.then(() => {
    ended = true;
  });
  const response = await Promise.race([
    f.request(),
    new Promise((resolve) =>
      setTimeout(() => resolve(undefined), LEASE_MS * 3),
    ),
  ]);
  assert.ok(response, "观察租约必须释放请求，不能一直挂到任务结束");
  assert.equal(response.status, 408);
  assert.match((await response.json()).error, /租约已到期.*任务继续运行/);
  assert.equal(ended, false);
  const next = f.request();
  await until(() => f.entered.length === 2);
  f.task.resolve({ ended: true });
  assert.equal((await next).status, 200);
  assert.deepEqual(await (await next).json(), { ended: true });
});

test("客户端取消只释放等待配额；下次等待可用且原任务继续", async (t) => {
  const f = await fixture(t, { leaseMs: 3000, capacity: 1 });
  const controller = new AbortController();
  const first = f.request(controller.signal).catch((error) => error);
  await until(() => f.entered.length === 1);
  const overflow = await f.request();
  assert.equal(overflow.status, 429);
  await overflow.json();
  controller.abort();
  await first;
  await until(() => f.entered[0].aborted);
  const next = f.request();
  await until(() => f.entered.length === 2);
  assert.equal(f.entered[1].aborted, false);
  f.task.resolve({ ended: true });
  assert.equal((await next).status, 200);
});

test("服务关闭释放所有观察者与连接，之后拒绝新等待", async (t) => {
  const f = await fixture(t, { leaseMs: 3000 });
  const first = f.request();
  await until(() => f.entered.length === 1);
  const closing = f.waits.close();
  await Promise.race([
    closing,
    new Promise((resolve) => setTimeout(resolve, 100)),
  ]);
  assert.equal(
    f.entered[0].aborted,
    true,
    "关闭必须中止观察者，不能等任务结束",
  );
  await closing;
  const response = await first;
  assert.equal(response.status, 503);
  await response.json();
  const next = await f.request();
  assert.equal(next.status, 503);
  await next.json();
  f.task.resolve({ ended: true });
});

test("成功结束撤销租约与断连监听，旧时钟不会取消已完成的观察者", async (t) => {
  const f = await fixture(t);
  const pending = f.request();
  await until(() => f.entered.length === 1);
  f.task.resolve({ ended: true });
  const response = await pending;
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(f.entered[0].aborted, false, "正常响应关闭不等于取消请求");
  await new Promise((resolve) => setTimeout(resolve, LEASE_MS + 20));
  assert.equal(f.entered[0].aborted, false, "终态撤销到期计时器");
});

test("等待资源配置拒绝非法期限和配额", () => {
  for (const options of [
    { leaseMs: 0 },
    { leaseMs: 2 ** 31 },
    { leaseMs: 1.5 },
    { capacity: 0 },
    { capacity: 1.5 },
  ])
    assert.throws(() => createTaskWaits(options), {
      status: 422,
      message: "等待资源配置无效",
    });
});
